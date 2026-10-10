/**
 * The relay between a fake WebSocket and a real TCP server on a loopback
 * port standing in for Screen Sharing: bytes cross both ways untouched, a
 * ticket opens exactly one session, and whichever side ends, nothing is left
 * open — no TCP connection, no session.
 */
import { connect, type Socket } from "node:net";
import type { ExperimentalPluginWebSocket, ExperimentalPluginWebSocketHandlers } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CloseCode, PING_FRAME, PONG_FRAME } from "../shared/channels";
import { startFakeVnc, until, type FakeVnc } from "../testing/fake-vnc";
import { createLoopbackLink } from "./loopback-link";
import type { OpenLink } from "./link";
import { createRelay, shortReason } from "./relay";
import { SessionRegistry } from "./sessions";

class FakeWebSocket implements ExperimentalPluginWebSocket {
  readyState = 1;
  sent: Uint8Array[] = [];
  /** Text frames: the relay's answers to the page's pings, and nothing else. */
  texts: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.texts.push(data);
    else this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    // As bb's `ws` does: a reason over 123 bytes of UTF-8 is refused and nothing is closed.
    if (reason !== undefined && Buffer.byteLength(reason) > 123) throw new SyntaxError("The message must not be greater than 123 bytes");
    this.closes.push({ code, reason });
    this.readyState = 3;
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

function loopback(port: number, windowBytes = 1024 * 1024, maxBufferedBytes = 1024 * 1024): OpenLink {
  return (_target, events) =>
    createLoopbackLink({ socket: connect({ host: "127.0.0.1", port }), windowBytes, maxBufferedBytes }, events);
}

function open(query: string, openLink: OpenLink = loopback(vnc.port)): { ws: FakeWebSocket; handlers: ExperimentalPluginWebSocketHandlers } {
  const relay = createRelay({ registry, openLink, log: (message) => logs.push(message) });
  const url = new URL(`http://127.0.0.1/api/v1/plugins/screen-sharing/http/vnc?${query}`);
  const handlers = relay({ request: new Request(url), url, headers: new Headers() });
  const ws = new FakeWebSocket();
  void handlers.onOpen?.(ws);
  return { ws, handlers };
}

function ticket(hostId = "mini"): string {
  return `host=${hostId}&flow=ack&token=${registry.mint({ hostId, hostName: "MacMini", route: "loopback" }).token}`;
}

const total = (chunks: Uint8Array[]) => chunks.reduce((sum, chunk) => sum + chunk.length, 0);

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
    const { ws } = open("host=mini&flow=ack&token=made-up");
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
    const { ws } = open(`host=laptop&flow=ack&token=${registry.mint({ hostId: "mini", hostName: "MacMini", route: "loopback" }).token}`);
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
    const relay = createRelay({ registry, openLink: loopback(port), log: () => {} });
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
    expect(ws.closes).toEqual([{ code: CloseCode.idle, reason: "no traffic for too long" }]);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("closes on a text frame that is not an ack, which VNC never sends", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => vnc.sockets.length === 1, "the connection");
    await handlers.onMessage?.(ws, "hello");
    expect(ws.closes[0]?.code).toBe(CloseCode.policy);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("answers the page's ping, so the page can tell the relay is still there, and sends the Mac nothing", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => ws.sent.length > 0, "the greeting");
    now += 50_000;
    await handlers.onMessage?.(ws, PING_FRAME);
    expect(ws.texts).toEqual([PONG_FRAME]);
    expect(ws.closes).toEqual([]);
    // A ping is traffic: the page is there, even when the screen is still.
    now += 50_000;
    registry.sweep();
    expect(ws.closes).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(vnc.received).toEqual([]);
  });

  it("closes on an ack for bytes the page was never sent", async () => {
    const { ws, handlers } = open(ticket());
    await until(() => ws.sent.length > 0, "the greeting");
    await handlers.onMessage?.(ws, `ack:${total(ws.sent) + 1}`);
    expect(ws.closes).toEqual([{ code: CloseCode.policy, reason: "the page acknowledged bytes it was never sent" }]);
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("turns away a page from before flow control, leaving its ticket unused", async () => {
    const minted = registry.mint({ hostId: "mini", hostName: "MacMini", route: "loopback" }).token;
    const { ws } = open(`host=mini&token=${minted}`);
    expect(ws.closes).toEqual([{ code: CloseCode.policy, reason: "this page is out of date; reload bb and connect again" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vnc.sockets).toHaveLength(0);
  });

  it("stops reading from Screen Sharing while the page is behind, and goes on once it catches up", async () => {
    const window = 64 * 1024;
    const { ws, handlers } = open(ticket(), loopback(vnc.port, window));
    await until(() => vnc.sockets.length === 1, "the connection");
    const mac = vnc.sockets[0] as Socket;
    const block = Buffer.alloc(16 * 1024, 7);
    // The Mac sends 4 MiB as fast as TCP lets it; the page acknowledges nothing yet.
    let written = 0;
    const pump = () => {
      while (written < 4 * 1024 * 1024 && mac.write(block)) written += block.length;
      if (written < 4 * 1024 * 1024) mac.once("drain", () => ((written += block.length), pump()));
    };
    pump();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // One socket read past the window at most, whatever TCP buffers below it.
    const stalled = total(ws.sent);
    expect(stalled).toBeGreaterThan(window);
    expect(stalled).toBeLessThan(window + 128 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(total(ws.sent)).toBe(stalled);

    // Acknowledging as it goes lets everything through.
    while (total(ws.sent) < 4 * 1024 * 1024 + 12) {
      await handlers.onMessage?.(ws, `ack:${total(ws.sent)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(ws.closes).toEqual([]);
    await handlers.onClose?.(ws, { code: 1000, reason: "" });
    await until(() => vnc.closed === 1, "the TCP close");
  });

  it("ends the session, instead of throwing, when the page's socket refuses a send", async () => {
    const { ws } = open(ticket());
    ws.send = () => {
      throw new Error("socket is closing");
    };
    await until(() => ws.closes.length === 1, "the WebSocket close");
    expect(ws.closes[0]).toEqual({ code: CloseCode.failed, reason: "could not send to the page (socket is closing)" });
    await until(() => vnc.closed === 1, "the TCP close");
    expect(registry.list()).toEqual([]);
  });

  it("tells the page why even when the reason names a Mac in a script of many bytes a character", async () => {
    const name = "測試電腦".repeat(10);
    const reason = `${name}: Screen Sharing closed the connection`;
    expect(reason.length).toBeLessThan(100);
    expect(Buffer.byteLength(reason)).toBeGreaterThan(123);
    const ending: OpenLink = (_target, events) => {
      queueMicrotask(() => events.end(CloseCode.normal, reason));
      return { write() {}, ack() {}, close() {} };
    };
    const { ws } = open(ticket(), ending);
    await until(() => ws.closes.length === 1, "the WebSocket close");
    const sent = ws.closes[0]?.reason ?? "";
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(123);
    expect(sent.endsWith("…")).toBe(true);
    expect(reason.startsWith(sent.slice(0, -1))).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("cuts a reason at whole characters and leaves a short one alone", () => {
    expect(shortReason("Screen Sharing closed the connection")).toBe("Screen Sharing closed the connection");
    const emoji = "🖥️".repeat(40);
    const cut = shortReason(emoji);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(123);
    expect(cut).not.toContain("\uFFFD");
    expect([...cut.slice(0, -1)].every((character) => emoji.includes(character))).toBe(true);
    expect(Buffer.byteLength(shortReason("a".repeat(123)))).toBe(123);
    expect(shortReason("a".repeat(124))).toBe(`${"a".repeat(120)}…`);
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
    expect(logs).toEqual([expect.stringMatching(/^session id-\d+ opened \(loopback\)$/), expect.stringMatching(/^session id-\d+ closed$/)]);
  });
});
