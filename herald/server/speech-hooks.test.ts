import { describe, expect, it, vi } from "vitest";

import type { HookRun } from "../shared/speech-hooks";
import { SPEECH_HOOKS_KEY, SpeechHooksStore, type HostSessionsPort } from "./speech-hooks";

const OK: HookRun = { exitCode: 0, signal: null, timedOut: false, durationMs: 12, stderr: "" };

function setup(host: Partial<HostSessionsPort> = {}) {
  const rows = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const port = {
    begin: vi.fn<HostSessionsPort["begin"]>(async () => ({ open: true, before: OK })),
    renew: vi.fn<HostSessionsPort["renew"]>(async () => ({ open: true })),
    end: vi.fn<HostSessionsPort["end"]>(async () => ({ after: OK })),
    ...host,
  };
  const store = new SpeechHooksStore({
    kv: {
      get: async <T>(key: string) => (rows.get(key) as T | undefined) ?? null,
      set: async (key, value) => {
        rows.set(key, structuredClone(value));
      },
    },
    host: port,
    log,
  });
  return { store, rows, log, port };
}

describe("SpeechHooksStore", () => {
  it("has no hooks by default, and opens nothing on any machine", async () => {
    const { store, port } = setup();
    await expect(store.all()).resolves.toEqual({});
    await expect(store.of("host_a")).resolves.toEqual({ before: "", after: "" });
    await expect(store.begin("host_a", "r1")).resolves.toEqual({ open: false, error: null });
    expect(port.begin).not.toHaveBeenCalled();
  });

  it("opens a run with the machine's own commands, never another machine's", async () => {
    const { store, port, log } = setup();
    await store.set("host_a", { before: " pause-a ", after: "" });
    await store.set("host_b", { before: "", after: "play-b" });
    await expect(store.begin("host_a", "r1")).resolves.toEqual({ open: true, error: null });
    await expect(store.begin("host_b", "r2")).resolves.toEqual({ open: true, error: null });
    expect(vi.mocked(port.begin).mock.calls.map(([hostId, input]) => [hostId, input])).toEqual([
      ["host_a", { runId: "r1", before: "pause-a", after: "", leaseMs: 30_000 }],
      ["host_b", { runId: "r2", before: "", after: "play-b", leaseMs: 30_000 }],
    ]);
    expect(log.info).toHaveBeenCalledWith("Ran the before-speaking hook on host_a (12 ms).");
  });

  it("ends a run on its machine whatever is stored now, since the run still owes its after hook", async () => {
    const { store, port } = setup();
    await store.set("host_a", { before: "pause", after: "play" });
    await store.begin("host_a", "r1");
    await store.set("host_a", { before: "", after: "" });
    await expect(store.end("host_a", "r1")).resolves.toEqual({ error: null });
    expect(port.end).toHaveBeenCalledWith("host_a", { runId: "r1" });
  });

  it("reads a blank command as empty, and forgets a machine whose hooks are both emptied", async () => {
    const { store, rows, port } = setup();
    await store.set("host_a", { before: "  \n ", after: " " });
    expect(rows.get(SPEECH_HOOKS_KEY)).toEqual({});
    await expect(store.begin("host_a", "r1")).resolves.toEqual({ open: false, error: null });
    expect(port.begin).not.toHaveBeenCalled();
  });

  it("keeps both of two saves made at once", async () => {
    const { store } = setup();
    await Promise.all([store.set("host_a", { before: "a", after: "" }), store.set("host_b", { before: "b", after: "" })]);
    await expect(store.all()).resolves.toEqual({ host_a: { before: "a", after: "" }, host_b: { before: "b", after: "" } });
  });

  it("logs and answers a hook that fails or is stopped, without throwing", async () => {
    const { store, log } = setup({
      begin: async () => ({ open: true, before: { ...OK, exitCode: null, signal: "SIGKILL", timedOut: true, durationMs: 5_004 } }),
      end: async () => ({ after: { ...OK, exitCode: 3, stderr: "no music app\n" } }),
    });
    await store.set("host_a", { before: "sleep 60", after: "play" });
    const stopped = "The before-speaking hook on host_a failed: it was stopped after 5 seconds";
    await expect(store.begin("host_a", "r1")).resolves.toEqual({ open: true, error: stopped });
    const failed = "The after-speaking hook on host_a failed: it exited with 3: no music app";
    await expect(store.end("host_a", "r1")).resolves.toEqual({ error: failed });
    expect(log.warn).toHaveBeenCalledWith(stopped);
    expect(log.warn).toHaveBeenCalledWith(failed);
  });

  it("answers an unknown opening when the machine could not be reached, and an end that failed", async () => {
    const { store } = setup({
      begin: async () => Promise.reject(new Error("host_a is offline")),
      end: async () => Promise.reject(new Error("host_a is offline")),
      renew: async () => Promise.reject(new Error("host_a is offline")),
    });
    await store.set("host_a", { before: "pause", after: "play" });
    await expect(store.begin("host_a", "r1")).resolves.toEqual({
      open: null,
      error: "Could not start a run of speech on host_a: host_a is offline",
    });
    // Unknown, not closed: the window keeps renewing.
    await expect(store.renew("host_a", "r1")).resolves.toBeNull();
    await expect(store.end("host_a", "r1")).resolves.toEqual({
      error: "Could not end a run of speech on host_a; it ends by itself shortly: host_a is offline",
    });
  });

  it("logs a run the machine ended by itself when its window stopped answering", async () => {
    const { store, log } = setup();
    store.endedByMachine("host_a", "expired", OK);
    expect(log.info).toHaveBeenCalledWith("A window speaking on host_a stopped answering, so its run of speech was ended there.");
    expect(log.info).toHaveBeenCalledWith("Ran the after-speaking hook on host_a (12 ms).");
  });

  it("logs a run ended by the machine's worker shutting down, with how its after hook failed", async () => {
    const { store, log } = setup();
    store.endedByMachine("host_a", "disposed", { ...OK, exitCode: 4, stderr: "disposal-hook-failed\n" });
    expect(log.info).toHaveBeenCalledWith("Herald's worker on host_a shut down during a run of speech, so the run was ended there.");
    expect(log.warn).toHaveBeenCalledWith("The after-speaking hook on host_a failed: it exited with 4: disposal-hook-failed");
  });

  it("reads an unreadable row as no hooks, and says so", async () => {
    const { store, rows, log, port } = setup();
    rows.set(SPEECH_HOOKS_KEY, { host_a: { before: 42 } });
    await expect(store.begin("host_a", "r1")).resolves.toEqual({ open: false, error: null });
    expect(log.error).toHaveBeenCalled();
    expect(port.begin).not.toHaveBeenCalled();
  });
});
