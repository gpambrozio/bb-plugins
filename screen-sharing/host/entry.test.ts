/**
 * The host entry through the SDK's host harness — the daemon's validation,
 * JSON transport, leases and lifecycle — against a fake Screen Sharing: a
 * session holds exactly one worker lease while open, its bytes leave as
 * `data` signals, and closing it, Close all on the server, or bb stopping the
 * worker leaves no socket and no lease.
 */
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closedPort, startFakeVnc, until, type FakeVnc } from "../testing/fake-vnc";
import { createHostEntry } from "./entry";

let vnc: FakeVnc;

beforeEach(async () => {
  vnc = await startFakeVnc((socket) => socket.write("RFB 003.889\n"));
});

afterEach(async () => {
  await vnc.close();
});

function harness(port = vnc.port, platform: NodeJS.Platform = "darwin") {
  return experimental_createHostEntryHarness(
    createHostEntry({ port, windowBytes: 1024 * 1024, silenceMs: 60_000, platform, serviceDisabled: async () => false }),
  );
}

describe("the host entry", () => {
  it("answers whether Screen Sharing is on, signing in to nothing", async () => {
    vnc.close();
    vnc = await startFakeVnc((socket) => socket.write(Buffer.concat([Buffer.from("RFB 003.889\n"), Buffer.from([2, 30, 33])])));
    const entry = harness();
    expect(await entry.experimental_call("status", {})).toEqual({
      state: "ready",
      rfbVersion: "RFB 003.889",
      securityTypes: [30, 33],
      signInSupported: true,
      refusedReason: null,
    });
    expect(entry.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await entry.experimental_dispose();
  });

  it("says a machine that is not a Mac has no Screen Sharing", async () => {
    const entry = harness(vnc.port, "linux");
    expect((await entry.experimental_call("status", {})).state).toBe("unsupported");
    await entry.experimental_dispose();
  });

  it("holds one worker lease per open session, and lets it go on close", async () => {
    const entry = harness();
    await entry.experimental_call("open", { sessionId: "s1" });
    await entry.experimental_call("open", { sessionId: "s2" });
    expect(entry.experimental_getRetainedWorkerLeaseCount()).toBe(2);
    await until(() => entry.experimental_getSignals().filter((signal) => signal.signal === "data").length === 2, "both greetings");
    expect(entry.experimental_getSignals()[0]).toEqual({
      signal: "data",
      payload: { sessionId: expect.stringMatching(/^s[12]$/), seq: 0, data: Buffer.from("RFB 003.889\n").toString("base64") },
    });

    await entry.experimental_call("write", { sessionId: "s1", seq: 0, data: Buffer.from("RFB 003.008\n").toString("base64") });
    await until(() => vnc.received.length === 1, "the bytes at the Mac");
    await entry.experimental_call("ack", { sessionId: "s1", bytes: 12 });
    expect(await entry.experimental_call("keepalive", { sessionId: "s1" })).toEqual({ open: true });

    await entry.experimental_call("close", { sessionId: "s1" });
    await until(() => entry.experimental_getRetainedWorkerLeaseCount() === 1, "the first lease back");
    expect(await entry.experimental_call("keepalive", { sessionId: "s1" })).toEqual({ open: false });
    await until(() => vnc.closed === 1, "the first TCP close");
    await entry.experimental_dispose();
  });

  it("gives the lease back when Screen Sharing cannot be reached", async () => {
    const entry = harness(await closedPort());
    await expect(entry.experimental_call("open", { sessionId: "s1" })).rejects.toThrow("cannot reach Screen Sharing (ECONNREFUSED)");
    await until(() => entry.experimental_getRetainedWorkerLeaseCount() === 0, "the lease back");
    await entry.experimental_dispose();
  });

  it("closes every session and lease when bb stops the worker, and tells the server", async () => {
    const entry = harness();
    await entry.experimental_call("open", { sessionId: "s1" });
    await entry.experimental_call("open", { sessionId: "s2" });
    await until(() => vnc.sockets.length === 2, "both connections");
    await entry.experimental_dispose();
    expect(entry.experimental_lifecycleSignal.aborted).toBe(true);
    await until(() => vnc.closed === 2, "both TCP closes");
    expect(entry.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    const closed = entry.experimental_getSignals().filter((signal) => signal.signal === "closed");
    expect(closed.map((signal) => signal.payload)).toEqual([
      { sessionId: "s1", reason: "the plugin's helper stopped", failed: true },
      { sessionId: "s2", reason: "the plugin's helper stopped", failed: true },
    ]);
  });

  it("refuses a write for a session it does not have", async () => {
    const entry = harness();
    await expect(entry.experimental_call("write", { sessionId: "nope", seq: 0, data: "" })).rejects.toThrow("no such session");
    await entry.experimental_dispose();
  });
});
