/**
 * The relay between a fake WebSocket and a real TCP server on a loopback
 * port standing in for Screen Sharing: bytes cross both ways untouched, a
 * ticket opens exactly one session, and whichever side ends, nothing is left
 * open — no TCP connection, no session.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { ExperimentalPluginWebSocket, ExperimentalPluginWebSocketHandlers } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CloseCode } from "../shared/channels";
import { createRelay } from "./relay";
import { SessionRegistry } from "./sessions";

/** A TCP server that records its connections and what they sent. */
interface FakeVnc {
  port: number;
  sockets: Socket[];
  received: Buffer[];
  closed: number;
  close(): Promise<void>;
}

async function startFakeVnc(onConnection?: (socket: Socket) => void): Promise<FakeVnc> {
  const fake: FakeVnc = { port: 0, sockets: [], received: [], closed: 0, close: async () => {} };
  const server: Server = createServer((socket) => {
    fake.sockets.push(socket);
    socket.on("data", (chunk) => fake.received.push(chunk));
    socket.on("close", () => fake.closed++);
    socket.on("error", () => {});
    onConnection?.(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.close = () =>
    new Promise((resolve) => {
      for (const socket of fake.sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}

class FakeWebSocket implements ExperimentalPluginWebSocket {
  readyState = 1;
  sent: Uint8Array[] = [];
  closes: { code?: number; reason?: string }[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") throw new Error("the relay sends binary only");
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let vnc: FakeVnc;
let now: number;
let registry: SessionRegistry;
let logs: string[];

beforeEach(async () => {
  vnc = await startFakeVnc((socket) => socket.write("RFB 003.889\n"));
  now = 0;
  let next = 0;
  logs = [];
  registry = new SessionRegistry({
    now: () => now,
    randomId: () => `id-${++next}`,
    ticketTtlMs: 30_000,
    idleMs: 60_000,
    maxAgeMs: 600_000,
    maxTickets: 16,
    onChange: () => {},
  });
});

afterEach(async () => {
  await vnc.close();
});

function open(query: string): { ws: FakeWebSocket; handlers: ExperimentalPluginWebSocketHandlers } {
  const relay = createRelay({
    registry,
    connect: () => connect({ host: "127.0.0.1", port: vnc.port }),
    maxBufferedBytes: 1024 * 1024,
    log: (message) => logs.push(message),
  });
  const url = new URL(`http://127.0.0.1/api/v1/plugins/screen-sharing/http/vnc?${query}`);
  const handlers = relay({ request: new Request(url), url, headers: new Headers() });
  const ws = new FakeWebSocket();
  void handlers.onOpen?.(ws);
  return { ws, handlers };
}

function ticket(hostId = "mini"): string {
  return `host=${hostId}&token=${registry.mint(hostId).token}`;
}

describe("the relay", () => {
  it("copies bytes both ways, untouched", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => ws.sent.length > 0, "the greeting");
    expect(Buffer.from(ws.sent[0] ?? []).toString("latin1")).toBe("RFB 003.889\n");

    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await handlers.onMessage?.(ws, bytes);
    await until(() => vnc.received.length > 0, "the bytes at the server");
    expect([...Buffer.concat(vnc.received)]).toEqual([...bytes]);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses a WebSocket without a ticket and never connects", async () => {
    const { ws } = open("host=mini&token=made-up");
    expect(ws.closes).toEqual([{ code: CloseCode.policy, reason: "unknown or already used ticket" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vnc.sockets).toHaveLength(0);
    expect(registry.list()).toEqual([]);
  });

  it("opens one session per ticket", async () => {
    const query = ticket();
    const first = open(query);
    const second = open(query);
    expect(second.ws.closes[0]?.code).toBe(CloseCode.policy);
    await until(() => vnc.sockets.length === 1, "the first connection");
    expect(first.ws.closes).toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses a ticket for another Mac", () => {
    const { ws } = open(`host=laptop&token=${registry.mint("mini").token}`);
    expect(ws.closes).toEqual([{ code: CloseCode.policy, reason: "ticket is for another Mac" }]);
  });

  it("drops the TCP connection when the app closes", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    await handlers.onClose?.(ws, { code: 1000, reason: "" });
    await until(() => vnc.closed === 1, "the TCP close");
    expect(registry.list()).toEqual([]);
    expect(ws.closes).toEqual([]);
  });

  it("drops the TCP connection on a WebSocket error", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    handlers.onError?.(ws, new Error("reset"));
    await until(() => vnc.closed === 1, "the TCP close");
    expect(registry.list()).toEqual([]);
  });

  it("closes the WebSocket when Screen Sharing hangs up", async () => {
    const { ws } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    vnc.sockets[0]?.end();
    await until(() => ws.closes.length === 1, "the WebSocket close");
    expect(ws.closes[0]).toEqual({ code: CloseCode.normal, reason: "Screen Sharing closed the connection" });
    expect(registry.list()).toEqual([]);
  });

  it("says so when Screen Sharing cannot be reached", async () => {
    const port = vnc.port;
    await vnc.close();
    const relay = createRelay({
      registry,
      connect: () => connect({ host: "127.0.0.1", port }),
      maxBufferedBytes: 1024,
      log: () => {},
    });
    const url = new URL(`http://127.0.0.1/vnc?${ticket()}`);
    const ws = new FakeWebSocket();
    await relay({ request: new Request(url), url, headers: new Headers() }).onOpen?.(ws);
    await until(() => ws.closes.length === 1, "the WebSocket close");
    expect(ws.closes[0]).toEqual({ code: CloseCode.failed, reason: "cannot reach Screen Sharing (ECONNREFUSED)" });
    expect(registry.list()).toEqual([]);
    vnc = await startFakeVnc();
  });

  it("is ended by Close all, both sides", async () => {
    const { ws } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    expect(registry.closeAll()).toBe(1);
    expect(ws.closes).toEqual([{ code: CloseCode.closedByUser, reason: "closed from bb" }]);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("is ended when idle", async () => {
    const { ws } = open(ticket());
    await until(() => ws.sent.length > 0, "the greeting");
    now += 60_000;
    registry.sweep();
    expect(ws.closes).toEqual([{ code: CloseCode.idle, reason: "session was idle too long" }]);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("closes on a text frame, which VNC never sends", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    await handlers.onMessage?.(ws, "hello");
    expect(ws.closes[0]?.code).toBe(CloseCode.policy);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("logs sessions without their bytes or tickets", async () => {
    const query = ticket();
    const { ws, handlers } = open(query);
    await until(() => ws.sent.length > 0, "the greeting");
    await handlers.onMessage?.(ws, new TextEncoder().encode("secret-ish bytes"));
    await handlers.onClose?.(ws, { code: 1000, reason: "" });
    const token = new URLSearchParams(query).get("token") ?? "";
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain("secret-ish");
    expect(logs).toEqual([expect.stringMatching(/^session id-\d+ opened$/), expect.stringMatching(/^session id-\d+ closed$/)]);
  });
});
