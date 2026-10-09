/**
 * The host half of a remote session against a fake Screen Sharing on a
 * loopback port: bytes cross both ways untouched and in order, the Mac's
 * bytes go out in numbered chunks no bigger than a chunk, reading stops while
 * the viewer is a window behind, and every way a session ends — the Mac, the
 * server, Close all, a write out of order, the server going quiet, a failed
 * signal — closes the TCP connection and releases the session's worker lease.
 */
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closedPort, sleep, startFakeVnc, until, type FakeVnc } from "../testing/fake-vnc";
import { HostRelay, type HostRelayOptions, type SessionPort } from "./relay";

interface FakePort extends SessionPort {
  data: { seq: number; bytes: Buffer }[];
  closed: { reason: string; failed: boolean }[];
  released: number;
}

function fakePort(emitData?: () => Promise<unknown>): FakePort {
  const port: FakePort = {
    data: [],
    closed: [],
    released: 0,
    emitData: async (payload) => {
      port.data.push({ seq: payload.seq, bytes: Buffer.from(payload.data, "base64") });
      await emitData?.();
    },
    emitClosed: async (payload) => {
      port.closed.push({ reason: payload.reason, failed: payload.failed });
    },
    lease: {
      dispose: async () => {
        port.released++;
      },
    },
  };
  return port;
}

const received = (port: FakePort) => Buffer.concat(port.data.map((chunk) => chunk.bytes));
const b64 = (text: string) => Buffer.from(text, "latin1").toString("base64");

let vnc: FakeVnc;
let now: number;
let logs: string[];
let relays: HostRelay[];

function relay(overrides: Partial<HostRelayOptions> = {}): HostRelay {
  const created = new HostRelay({
    connect: () => connect({ host: "127.0.0.1", port: vnc.port }),
    windowBytes: 1024 * 1024,
    maxChunkBytes: 64 * 1024,
    maxWriteBufferBytes: 1024 * 1024,
    silenceMs: 60_000,
    connectTimeoutMs: 2000,
    now: () => now,
    log: (message) => logs.push(message),
    ...overrides,
  });
  relays.push(created);
  return created;
}

beforeEach(async () => {
  vnc = await startFakeVnc((socket) => socket.write("RFB 003.889\n"));
  now = 0;
  logs = [];
  relays = [];
});

afterEach(async () => {
  for (const created of relays) created.closeAll("test over");
  await vnc.close();
});

describe("a remote session on its Mac", () => {
  it("passes the Mac's bytes on as numbered chunks, and the viewer's to the Mac in order", async () => {
    const host = relay();
    const port = fakePort();
    await host.open("s1", port);
    await until(() => port.data.length > 0, "the greeting");
    expect(port.data[0]).toEqual({ seq: 0, bytes: Buffer.from("RFB 003.889\n") });

    host.write("s1", 0, b64("RFB 003.008\n"));
    host.write("s1", 1, Buffer.from([0, 1, 250, 255]).toString("base64"));
    await until(() => Buffer.concat(vnc.received).length === 16, "the bytes at the Mac");
    expect([...Buffer.concat(vnc.received).subarray(12)]).toEqual([0, 1, 250, 255]);
    expect(port.released).toBe(0);
  });

  it("splits what the Mac sends into chunks no bigger than a chunk, numbered without a gap", async () => {
    const host = relay({ maxChunkBytes: 1000 });
    const port = fakePort();
    await host.open("s1", port);
    const screen = Buffer.alloc(250_000);
    for (let index = 0; index < screen.length; index++) screen[index] = index % 251;
    await until(() => vnc.sockets.length === 1, "the connection");
    vnc.sockets[0]?.write(screen);
    await until(() => received(port).length === 12 + screen.length, "the whole screen");
    expect(received(port).subarray(12).equals(screen)).toBe(true);
    expect(port.data.every((chunk) => chunk.bytes.length <= 1000)).toBe(true);
    expect(port.data.map((chunk) => chunk.seq)).toEqual(port.data.map((_, index) => index));
  });

  it("stops reading from the Mac while the viewer is a window behind, and goes on as it acknowledges", async () => {
    const window = 256 * 1024;
    const host = relay({ windowBytes: window });
    const port = fakePort();
    await host.open("s1", port);
    await until(() => vnc.sockets.length === 1, "the connection");
    const mac = vnc.sockets[0] as Socket;
    const size = 8 * 1024 * 1024;
    mac.write(Buffer.alloc(size, 1));
    await sleep(200);
    const stalled = received(port).length;
    // What TCP buffers below the relay stays in the kernel; the relay itself holds at most one read past its window.
    expect(stalled).toBeGreaterThan(window);
    expect(stalled).toBeLessThan(window + 128 * 1024);
    await sleep(100);
    expect(received(port).length).toBe(stalled);

    while (received(port).length < 12 + size) {
      host.ack("s1", received(port).length);
      await sleep(1);
    }
    expect(port.closed).toEqual([]);
  });

  it("ends a session whose viewer acknowledges bytes it was never sent", async () => {
    const host = relay();
    const port = fakePort();
    await host.open("s1", port);
    await until(() => port.data.length > 0, "the greeting");
    host.ack("s1", 13);
    expect(port.closed).toEqual([{ reason: "the viewer acknowledged 13 bytes of 12", failed: true }]);
    await until(() => vnc.closed === 1, "the TCP close");
    expect(port.released).toBe(1);
  });

  it("ends a session on a write out of order, before it reaches the Mac", async () => {
    const host = relay();
    const port = fakePort();
    await host.open("s1", port);
    host.write("s1", 1, b64("too early"));
    expect(port.closed).toEqual([{ reason: "bytes from the viewer arrived out of order (expected 0, got 1)", failed: true }]);
    await until(() => vnc.closed === 1, "the TCP close");
    expect(Buffer.concat(vnc.received).toString()).toBe("");
    expect(port.released).toBe(1);
    expect(host.size).toBe(0);
    expect(() => host.write("s1", 0, b64("x"))).toThrow("no such session");
  });

  it("when the Mac hangs up, passes on what it said first, then says the session closed", async () => {
    const host = relay();
    const port = fakePort(() => sleep(5));
    await host.open("s1", port);
    await until(() => vnc.sockets.length === 1, "the connection");
    vnc.sockets[0]?.end("last words");
    await until(() => port.closed.length === 1, "the closed signal");
    expect(received(port).toString()).toBe("RFB 003.889\nlast words");
    expect(port.closed).toEqual([{ reason: "Screen Sharing closed the connection", failed: false }]);
    expect(port.released).toBe(1);
    expect(host.size).toBe(0);
  });

  it("closes the Mac's connection when the server ends the session, without a closed signal", async () => {
    const host = relay();
    const port = fakePort();
    await host.open("s1", port);
    host.close("s1");
    host.close("s1");
    host.close("never-opened");
    await until(() => vnc.closed === 1, "the TCP close");
    expect(port.closed).toEqual([]);
    expect(port.released).toBe(1);
    expect(host.keepalive("s1")).toBe(false);
  });

  it("closes every session, telling the server, when its worker stops", async () => {
    const host = relay();
    const ports = [fakePort(), fakePort()];
    await host.open("s1", ports[0] as FakePort);
    await host.open("s2", ports[1] as FakePort);
    host.closeAll("the plugin's helper stopped");
    await until(() => vnc.closed === 2, "both TCP closes");
    for (const port of ports) {
      expect(port.closed).toEqual([{ reason: "the plugin's helper stopped", failed: true }]);
      expect(port.released).toBe(1);
    }
  });

  it("ends a session the server has gone quiet about, and keeps one it still calls about", async () => {
    const host = relay({ silenceMs: 60_000 });
    const quiet = fakePort();
    const kept = fakePort();
    await host.open("quiet", quiet);
    await host.open("kept", kept);
    now += 40_000;
    expect(host.keepalive("kept")).toBe(true);
    now += 30_000;
    host.sweep();
    expect(quiet.closed).toEqual([{ reason: "the bb server stopped asking for it", failed: true }]);
    expect(quiet.released).toBe(1);
    expect(kept.closed).toEqual([]);
    expect(host.size).toBe(1);
  });

  it("ends a session whose bytes cannot be passed on", async () => {
    const host = relay();
    const port = fakePort(() => Promise.reject(new Error("the daemon link is gone")));
    await host.open("s1", port);
    await until(() => port.released === 1, "the lease release");
    expect(host.size).toBe(0);
    await until(() => vnc.closed === 1, "the TCP close");
    expect(logs).toContain("session s1 closed: could not pass the screen on (the daemon link is gone)");
  });

  it("fails to open when Screen Sharing is not there, and gives the lease back", async () => {
    const port = await closedPort();
    const host = relay({ connect: () => connect({ host: "127.0.0.1", port }) });
    const lease = fakePort();
    await expect(host.open("s1", lease)).rejects.toThrow("cannot reach Screen Sharing (ECONNREFUSED)");
    expect(lease.released).toBe(1);
    expect(host.size).toBe(0);
  });

  it("never opens a session closed while it was connecting, whoever closed it", async () => {
    const host = relay();
    const byServer = fakePort();
    const opening = host.open("s1", byServer);
    host.close("s1");
    await expect(opening).rejects.toThrow("the session was closed while it was connecting");
    expect(byServer.released).toBe(1);

    const cancelled = new AbortController();
    const byBb = fakePort();
    const aborted = host.open("s2", byBb, cancelled.signal);
    cancelled.abort();
    await expect(aborted).rejects.toThrow("the session was closed while it was connecting");
    expect(byBb.released).toBe(1);

    const byStopping = fakePort();
    const stopping = host.open("s3", byStopping);
    host.closeAll("the plugin's helper stopped");
    await expect(stopping).rejects.toThrow("the session was closed while it was connecting");
    expect(byStopping.released).toBe(1);
    const late = fakePort();
    await expect(host.open("s4", late)).rejects.toThrow("the plugin's helper is stopping");
    expect(late.released).toBe(1);

    expect(host.size).toBe(0);
    await until(() => vnc.closed === vnc.sockets.length, "every TCP connection closed");
  });

  it("refuses a second open of the same session", async () => {
    const host = relay();
    await host.open("s1", fakePort());
    const second = fakePort();
    await expect(host.open("s1", second)).rejects.toThrow("session is already open");
    expect(second.released).toBe(1);
    await sleep(50);
    expect(vnc.sockets).toHaveLength(1);
  });

  it("logs session ids and reasons, never bytes", async () => {
    const host = relay();
    const port = fakePort();
    await host.open("s1", port);
    host.write("s1", 0, b64("secret-ish bytes"));
    await until(() => vnc.received.length > 0, "the bytes at the Mac");
    host.close("s1");
    expect(logs).toEqual(["session s1 opened", "session s1 closed: closed by the server"]);
  });
});
