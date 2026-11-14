import { describe, expect, it, vi } from "vitest";

import type { HookRun } from "../shared/speech-hooks";
import { SPEECH_HOOKS_KEY, SpeechHooksStore, type SpeechHooksDeps } from "./speech-hooks";

const OK: HookRun = { exitCode: 0, signal: null, timedOut: false, durationMs: 12, stderr: "" };

function setup(runOnHost: SpeechHooksDeps["runOnHost"] = vi.fn(async () => OK)) {
  const rows = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: SpeechHooksDeps = {
    kv: {
      get: async <T>(key: string) => (rows.get(key) as T | undefined) ?? null,
      set: async (key, value) => {
        rows.set(key, structuredClone(value));
      },
    },
    runOnHost,
    log,
  };
  return { store: new SpeechHooksStore(deps), rows, log, runOnHost };
}

describe("SpeechHooksStore", () => {
  it("has no hooks by default, and runs nothing on any machine", async () => {
    const { store, runOnHost } = setup();
    await expect(store.all()).resolves.toEqual({});
    await expect(store.of("host_a")).resolves.toEqual({ before: "", after: "" });
    await expect(store.run("host_a", "before")).resolves.toEqual({ ran: false, error: null });
    await expect(store.run("host_a", "after")).resolves.toEqual({ ran: false, error: null });
    expect(runOnHost).not.toHaveBeenCalled();
  });

  it("keeps each machine's hooks apart, and runs a machine's own command there", async () => {
    const { store, runOnHost } = setup();
    await store.set("host_a", { before: "say-before-a", after: "" });
    await store.set("host_b", { before: "", after: "say-after-b" });
    await expect(store.run("host_a", "before")).resolves.toEqual({ ran: true, error: null });
    await expect(store.run("host_a", "after")).resolves.toEqual({ ran: false, error: null });
    await expect(store.run("host_b", "after")).resolves.toEqual({ ran: true, error: null });
    expect(vi.mocked(runOnHost).mock.calls.map(([hostId, kind, command]) => [hostId, kind, command])).toEqual([
      ["host_a", "before", "say-before-a"],
      ["host_b", "after", "say-after-b"],
    ]);
  });

  it("reads a blank command as empty, and forgets a machine whose hooks are both emptied", async () => {
    const { store, rows, runOnHost } = setup();
    await store.set("host_a", { before: "  \n ", after: "x" });
    await expect(store.run("host_a", "before")).resolves.toEqual({ ran: false, error: null });
    await store.set("host_a", { before: "", after: " " });
    expect(rows.get(SPEECH_HOOKS_KEY)).toEqual({});
    expect(runOnHost).not.toHaveBeenCalled();
  });

  it("keeps both of two saves made at once", async () => {
    const { store } = setup();
    await Promise.all([store.set("host_a", { before: "a", after: "" }), store.set("host_b", { before: "b", after: "" })]);
    await expect(store.all()).resolves.toEqual({ host_a: { before: "a", after: "" }, host_b: { before: "b", after: "" } });
  });

  it("logs and answers a hook that fails, without throwing", async () => {
    const { store, log } = setup(async () => ({ ...OK, exitCode: 3, stderr: "no music app\n" }));
    await store.set("host_a", { before: "pause-music", after: "" });
    const expected = "The before-speaking hook on host_a failed: it exited with 3: no music app";
    await expect(store.run("host_a", "before")).resolves.toEqual({ ran: true, error: expected });
    expect(log.warn).toHaveBeenCalledWith(expected);
  });

  it("logs a hook stopped for taking too long, and a machine that could not be reached", async () => {
    const slow = setup(async () => ({ ...OK, exitCode: null, signal: "SIGKILL", timedOut: true }));
    await slow.store.set("host_a", { before: "sleep 60", after: "" });
    await expect(slow.store.run("host_a", "before")).resolves.toEqual({
      ran: true,
      error: "The before-speaking hook on host_a failed: it was stopped after 5 seconds",
    });
    const away = setup(async () => Promise.reject(new Error("host_a is offline")));
    await away.store.set("host_a", { before: "", after: "resume-music" });
    await expect(away.store.run("host_a", "after")).resolves.toEqual({
      ran: true,
      error: "The after-speaking hook on host_a failed: the machine could not run it: host_a is offline",
    });
  });

  it("reads an unreadable row as no hooks, and says so", async () => {
    const { store, rows, log, runOnHost } = setup();
    rows.set(SPEECH_HOOKS_KEY, { host_a: { before: 42 } });
    await expect(store.run("host_a", "before")).resolves.toEqual({ ran: false, error: null });
    expect(log.error).toHaveBeenCalled();
    expect(runOnHost).not.toHaveBeenCalled();
  });
});
