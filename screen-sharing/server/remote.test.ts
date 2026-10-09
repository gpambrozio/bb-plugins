/**
 * Sessions to Macs that are not the bb server's own, end to end: the real
 * server entry on bb's fake plugin host, its host calls and signals through a
 * fake daemon to a real HostRelay, and a fake Screen Sharing on a loopback
 * port for each Mac. The page is the fake WebSocket session, acknowledging
 * what it receives as the real page does.
 *
 * What it pins down: the host picker's list and statuses, tickets bound to
 * the chosen Mac, bytes crossing both ways in order, a gap in the Mac's
 * chunks ending the session, a slow page holding the Mac back, every way a
 * remote session ends leaving no socket and no lease on the Mac — and, with
 * the daemon delaying everything by 300 ms each way, the round trip and
 * throughput a user can expect, logged as `[measured]`.
 */
import type { Socket } from "node:net";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "../server";
import { CloseCode, SESSIONS_CHANGED, VNC_ROUTE, ackFrame } from "../shared/channels";
import { HOST_WINDOW_BYTES } from "../shared/limits";
import { FakeDaemon } from "../testing/fake-daemon";
import { sleep, startFakeVnc, until, type FakeVnc } from "../testing/fake-vnc";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];
type WsSession = Awaited<ReturnType<Harness["experimental_openWebSocket"]>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const READY = { state: "ready", rfbVersion: "RFB 003.889", securityTypes: [30, 33, 36, 35], signInSupported: true, refusedReason: null };

interface Setup {
  harness: Harness;
  daemon: FakeDaemon;
  laptop: FakeVnc;
}

async function setup(options: { oneWayMs?: number; windowBytes?: number; mac?: (socket: Socket) => void } = {}): Promise<Setup> {
  const laptop = await startFakeVnc(options.mac ?? ((socket) => socket.write("RFB 003.889\n")));
  cleanups.push(() => laptop.close());
  const daemon = new FakeDaemon({
    ports: { host_laptop: laptop.port, host_doxbook: laptop.port },
    oneWayMs: options.oneWayMs ?? 0,
    windowBytes: options.windowBytes ?? 1024 * 1024,
    status: (hostId) => {
      if (hostId === "host_linux") return { ...READY, state: "unsupported", rfbVersion: null, securityTypes: [], signInSupported: false };
      if (hostId === "host_broken") throw new Error("unknown host method \"status\"");
      return READY;
    },
  });
  cleanups.push(() => daemon.closeEverything());
  const { bb, harness } = createFakePluginHost({ pluginId: "screen-sharing", experimental_callHostRpc: daemon.call });
  daemon.harness = harness;
  cleanups.push(() => harness.dispose());
  harness.sdk.stub("system.config", () => ({ primaryHostId: "host_mini" }));
  harness.sdk.stub("hosts.list", () => [
    makeHostResponse({ id: "host_mini", name: "MacMini" }),
    makeHostResponse({ id: "host_laptop", name: "MacBook Pro" }),
    makeHostResponse({ id: "host_doxbook", name: "DoxBook" }),
    makeHostResponse({ id: "host_linux", name: "buildbox" }),
    makeHostResponse({ id: "host_broken", name: "Old bb" }),
    makeHostResponse({ id: "host_away", name: "Travel MacBook", status: "disconnected" }),
  ]);
  await plugin(bb);
  return { harness, daemon, laptop };
}

async function openSession(harness: Harness, hostId = "host_laptop"): Promise<WsSession> {
  const { token } = (await harness.callRpc("openSession", { hostId })) as { token: string };
  return harness.experimental_openWebSocket(`${VNC_ROUTE}?host=${hostId}&flow=ack&token=${token}`);
}

const binary = (ws: WsSession) => ws.sent.filter((frame): frame is Uint8Array => typeof frame !== "string");
const received = (ws: WsSession) => Buffer.concat(binary(ws));

/** Acknowledges what the page has received, as the page does every few milliseconds, until stopped. */
function acknowledging(ws: WsSession, everyMs = 20): () => void {
  let acked = 0;
  const timer = setInterval(() => {
    const total = received(ws).length;
    if (total > acked && ws.readyState === 1) {
      acked = total;
      void ws.receive(ackFrame(total));
    }
  }, everyMs);
  return () => clearInterval(timer);
}

describe("the host picker", () => {
  it("lists every enrolled machine, the server's first, with whether bb can reach it", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("hosts", {})).toEqual({
      hosts: [
        { id: "host_mini", name: "MacMini", connected: true, isServer: true },
        { id: "host_linux", name: "buildbox", connected: true, isServer: false },
        { id: "host_doxbook", name: "DoxBook", connected: true, isServer: false },
        { id: "host_laptop", name: "MacBook Pro", connected: true, isServer: false },
        { id: "host_broken", name: "Old bb", connected: true, isServer: false },
        { id: "host_away", name: "Travel MacBook", connected: false, isServer: false },
      ],
    });
  });

  it("asks each Mac about its own Screen Sharing, and nobody about one that is offline", async () => {
    const { harness, daemon } = await setup();
    expect(await harness.callRpc("status", { hostId: "host_laptop" })).toEqual({
      ...READY,
      hostId: "host_laptop",
      hostName: "MacBook Pro",
      isServer: false,
      unreachableReason: null,
    });
    const linux = await harness.callRpc("status", { hostId: "host_linux" });
    expect(linux).toMatchObject({ state: "unsupported", hostName: "buildbox" });
    expect(await harness.callRpc("status", { hostId: "host_away" })).toMatchObject({ state: "offline", hostName: "Travel MacBook" });
    expect(await harness.callRpc("status", { hostId: "host_broken" })).toMatchObject({
      state: "unreachable",
      unreachableReason: 'unknown host method "status"',
    });
    expect(daemon.calls.map((call) => call.hostId)).toEqual(["host_laptop", "host_linux", "host_broken"]);
    await expect(harness.callRpc("status", { hostId: "host_gone" })).rejects.toThrow("bb has no such machine");
  });
});

describe("a ticket for another Mac", () => {
  it("is minted for a connected Mac, and refused for an offline or unknown one", async () => {
    const { harness } = await setup();
    expect(await harness.callRpc("openSession", { hostId: "host_laptop" })).toMatchObject({ token: expect.any(String) });
    await expect(harness.callRpc("openSession", { hostId: "host_away" })).rejects.toThrow("Travel MacBook is offline");
    await expect(harness.callRpc("openSession", { hostId: "host_gone" })).rejects.toThrow("bb has no such machine");
  });

  it("opens nothing on any Mac when used for another one", async () => {
    const { harness, daemon } = await setup();
    const { token } = (await harness.callRpc("openSession", { hostId: "host_laptop" })) as { token: string };
    const ws = await harness.experimental_openWebSocket(`${VNC_ROUTE}?host=host_doxbook&flow=ack&token=${token}`);
    expect(ws.closeCalls).toEqual([{ code: CloseCode.policy, reason: "ticket is for another Mac" }]);
    await sleep(20);
    expect(daemon.calls).toEqual([]);
  });
});

describe("a remote session", () => {
  it("carries bytes both ways, in order, through the Mac's host entry", async () => {
    const { harness, daemon, laptop } = await setup();
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting");
    expect(received(ws).toString()).toBe("RFB 003.889\n");
    expect(daemon.leases).toBe(1);

    // Many small frames, as noVNC sends pointer moves: pipelined, yet in order at the Mac.
    const frames = Array.from({ length: 200 }, (_, index) => new Uint8Array([index % 256, 7]));
    for (const frame of frames) await ws.receive(frame);
    await until(() => Buffer.concat(laptop.received).length === 400, "every frame at the Mac");
    expect([...Buffer.concat(laptop.received)]).toEqual(frames.flatMap((frame) => [...frame]));
    expect(ws.closeCalls).toEqual([]);
    expect((await harness.callRpc("sessions", {})) as { sessions: unknown[] }).toMatchObject({ sessions: [{ hostId: "host_laptop" }] });
  });

  it("forwards the page's acknowledgements to the Mac, latest first", async () => {
    const { harness, daemon } = await setup();
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting");
    await ws.receive(ackFrame(4));
    await ws.receive(ackFrame(12));
    await until(() => daemon.calls.some((call) => call.method === "ack" && (call.input as { bytes: number }).bytes === 12), "the ack");
    expect(ws.closeCalls).toEqual([]);
  });

  it("ends the session when a chunk from the Mac goes missing", async () => {
    const { harness, daemon } = await setup();
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting");
    const [session] = ((await harness.callRpc("sessions", {})) as { sessions: { id: string }[] }).sessions;
    await harness.experimental_emitHostSignal("host_laptop", "data", { sessionId: session?.id, seq: 2, data: "AAAA" });
    expect(ws.closeCalls).toEqual([
      { code: CloseCode.failed, reason: "MacBook Pro: lost part of the screen on the way (expected 1, got 2)" },
    ]);
    await until(() => daemon.openSessions() === 0 && daemon.leases === 0, "the Mac's side closed");
  });

  it("ignores a signal for the session from another machine", async () => {
    const { harness } = await setup();
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting");
    const [session] = ((await harness.callRpc("sessions", {})) as { sessions: { id: string }[] }).sessions;
    await harness.experimental_emitHostSignal("host_doxbook", "data", { sessionId: session?.id, seq: 1, data: "AAAA" });
    await harness.experimental_emitHostSignal("host_doxbook", "closed", { sessionId: session?.id, reason: "forged", failed: true });
    expect(received(ws).length).toBe(12);
    expect(ws.closeCalls).toEqual([]);
  });

  it("holds the Mac back while the page is slow, and catches up once it acknowledges", async () => {
    const window = 512 * 1024;
    const size = 6 * 1024 * 1024;
    const { harness } = await setup({
      windowBytes: window,
      mac: (socket) => socket.write(Buffer.alloc(size, 3)),
    });
    const ws = await openSession(harness);
    await sleep(300);
    const stalled = received(ws).length;
    expect(stalled).toBeGreaterThan(0);
    // The host stops reading past its window; what is on its way is at most one TCP read more.
    expect(stalled).toBeLessThanOrEqual(window + 256 * 1024);
    await sleep(100);
    expect(received(ws).length).toBe(stalled);

    const stop = acknowledging(ws, 5);
    cleanups.push(stop);
    await until(() => received(ws).length === size, "the whole screen", 10_000);
    expect(ws.closeCalls).toEqual([]);
  });
});

describe("a remote session ends, leaving nothing open on the Mac", () => {
  async function opened(options: Parameters<typeof setup>[0] = {}) {
    const setUp = await setup(options);
    const ws = await openSession(setUp.harness);
    await until(() => received(ws).length === 12 && setUp.daemon.leases === 1, "the session");
    return { ...setUp, ws };
  }

  async function nothingLeft(daemon: FakeDaemon, laptop: FakeVnc, harness: Harness): Promise<void> {
    await until(() => daemon.openSessions() === 0, "the host's session closed");
    await until(() => daemon.leases === 0, "the lease released");
    await until(() => laptop.closed === laptop.sockets.length, "the Mac's TCP connection closed");
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
  }

  it("when the page closes", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    await ws.close(1000, "");
    await nothingLeft(daemon, laptop, harness);
  });

  it("on Close all, telling the page", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    expect(await harness.callRpc("closeAll", {})).toEqual({ closed: 1 });
    expect(ws.closeCalls).toEqual([{ code: CloseCode.closedByUser, reason: "closed from bb" }]);
    await nothingLeft(daemon, laptop, harness);
  });

  it("when the plugin stops", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    // Keep the daemon reachable after the fake host retires the plugin: the close is already on its way.
    const calls = daemon.calls.length;
    await harness.dispose();
    // bb closes a stopping plugin's sockets itself, before its dispose hooks run.
    expect(ws.closeCalls[0]?.code).toBe(CloseCode.bbPluginReloaded);
    await until(() => daemon.calls.length > calls, "the close on its way to the Mac");
    expect(daemon.calls.at(-1)?.method).toBe("close");
    await until(() => daemon.openSessions() === 0 && daemon.leases === 0, "the Mac's side closed");
  });

  it("when the Mac's Screen Sharing hangs up", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    laptop.sockets[0]?.end();
    await until(() => ws.closeCalls.length === 1, "the page told");
    expect(ws.closeCalls).toEqual([{ code: CloseCode.normal, reason: "MacBook Pro: Screen Sharing closed the connection" }]);
    await nothingLeft(daemon, laptop, harness);
  });

  it("when bb stops the plugin's worker on the Mac", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    daemon.stopWorker("host_laptop");
    await until(() => ws.closeCalls.length === 1, "the page told");
    expect(ws.closeCalls).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: the plugin's helper stopped" }]);
    await nothingLeft(daemon, laptop, harness);
  });

  it("when the worker on the Mac crashes", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    const [session] = ((await harness.callRpc("sessions", {})) as { sessions: { id: string }[] }).sessions;
    // A crash takes the worker's sockets with it and says nothing; bb reports the exit.
    daemon.relays.get("host_laptop")?.close(session?.id ?? "");
    await harness.experimental_emitHostWorkerExit("host_laptop");
    expect(ws.closeCalls).toEqual([{ code: CloseCode.failed, reason: "MacBook Pro: the plugin's helper stopped unexpectedly" }]);
    await nothingLeft(daemon, laptop, harness);
  });

  it("when the link to the Mac drops", async () => {
    const { harness, daemon, laptop, ws } = await opened();
    daemon.down.add("host_laptop");
    await ws.receive(new Uint8Array([1, 2, 3]));
    await until(() => ws.closeCalls.length === 1, "the page told");
    expect(ws.closeCalls[0]).toEqual({
      code: CloseCode.failed,
      reason: "MacBook Pro: lost the connection (host host_laptop is not connected)",
    });
    expect(await harness.callRpc("sessions", {})).toEqual({ sessions: [] });
    // The Mac still has it until it hears nothing more from the server.
    daemon.relays.get("host_laptop")?.sweep();
    expect(daemon.openSessions()).toBe(1);
    expect(laptop.closed).toBe(0);
  });

  it("when the page closes while the Mac is still connecting", async () => {
    const { harness, daemon, laptop } = await setup({ oneWayMs: 30 });
    const ws = await openSession(harness);
    await ws.close(1000, "");
    await until(() => daemon.calls.some((call) => call.method === "close"), "the late close");
    await nothingLeft(daemon, laptop, harness);
    expect(daemon.calls.map((call) => call.method)).toEqual(["open", "close"]);
  });

  it("and the sidebar hears about every open and close", async () => {
    const { harness, ws } = await opened();
    await ws.close(1000, "");
    await until(() => harness.realtimeSignals.filter((signal) => signal.channel === SESSIONS_CHANGED).length === 2, "two changes");
  });
});

describe("over a slow link (300 ms each way)", () => {
  const ONE_WAY_MS = 300;

  it("echoes a key in about one round trip, and many keys without one round trip each", async () => {
    const { harness } = await setup({
      oneWayMs: ONE_WAY_MS,
      mac: (socket) => {
        socket.write("RFB 003.889\n");
        socket.on("data", (chunk) => socket.write(chunk));
      },
    });
    const opening = Date.now();
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting", 5000);
    const toGreeting = Date.now() - opening;

    const pressed = Date.now();
    await ws.receive(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]));
    await until(() => received(ws).length === 20, "the echo", 5000);
    const roundTrip = Date.now() - pressed;

    // 30 keys typed 20 ms apart: each one is on its way at once, not behind the round trip before it.
    const typing = Date.now();
    for (let key = 0; key < 30; key++) {
      await ws.receive(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61 + (key % 26)]));
      await sleep(20);
    }
    await until(() => received(ws).length === 20 + 30 * 8, "every echo", 10_000);
    const typed = Date.now() - typing;
    console.info(`[measured] 300 ms each way: greeting after ${toGreeting} ms, key echo ${roundTrip} ms, 30 keys over 600 ms echoed after ${typed} ms`);

    // Up as a call, down as a signal: one round trip.
    expect(roundTrip).toBeGreaterThanOrEqual(2 * ONE_WAY_MS - 20);
    expect(roundTrip).toBeLessThan(2 * ONE_WAY_MS + 300);
    // Serialised, 30 keys would take 30 round trips (≈18 s); pipelined, the typing time plus one.
    expect(typed).toBeLessThan(30 * 20 + 2 * ONE_WAY_MS + 1000);
  }, 20_000);

  it("moves screen updates at about window ÷ round trip, with the window the host uses", async () => {
    const window = HOST_WINDOW_BYTES;
    const size = 3 * window;
    const { harness } = await setup({
      oneWayMs: ONE_WAY_MS,
      windowBytes: window,
      mac: (socket) => socket.write(Buffer.alloc(size, 9)),
    });
    const ws = await openSession(harness);
    const stop = acknowledging(ws, 50);
    cleanups.push(stop);
    await until(() => received(ws).length > 0, "the first chunk", 5000);
    const started = Date.now();
    await until(() => received(ws).length === size, "the whole screen", 30_000);
    const seconds = (Date.now() - started) / 1000;
    const rate = size / seconds / (1024 * 1024);
    console.info(`[measured] 300 ms each way, ${window / 1024 / 1024} MiB window: ${rate.toFixed(1)} MiB/s`);
    // The first window goes at once; each further one waits for credit, which takes a round trip back to the host.
    expect(seconds).toBeGreaterThanOrEqual((size / window - 1) * ((2 * ONE_WAY_MS) / 1000) - 0.05);
    expect(rate).toBeGreaterThan(1);
  }, 40_000);

  it("with no delay on the link, for comparison", async () => {
    const size = 32 * 1024 * 1024;
    const { harness } = await setup({
      windowBytes: 16 * 1024 * 1024,
      mac: (socket) => {
        socket.write("RFB 003.889\n");
        socket.once("data", () => socket.write(Buffer.alloc(size, 5)));
      },
    });
    const ws = await openSession(harness);
    await until(() => received(ws).length === 12, "the greeting");
    const stop = acknowledging(ws, 5);
    cleanups.push(stop);
    const started = Date.now();
    await ws.receive(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0]));
    await until(() => received(ws).length > 12, "the first update");
    const firstByte = Date.now() - started;
    await until(() => received(ws).length === 12 + size, "the whole update", 30_000);
    const rate = size / ((Date.now() - started) / 1000) / (1024 * 1024);
    console.info(`[measured] no link delay: first update byte after ${firstByte} ms, ${rate.toFixed(0)} MiB/s`);
    expect(firstByte).toBeLessThan(200);
  }, 40_000);
});
