import { describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../shared/host-contract";
import { createWrappers, PATHS_KEY } from "./wrappers";

function kv(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async <T,>(key: string) => data.get(key) as T | undefined,
    set: async (key: string, value: unknown) => void data.set(key, value),
  };
}

const log = { info: vi.fn(), warn: vi.fn() };

describe("the wrapper's path on each machine", () => {
  it("asks the machine once, then answers from memory, and saves the path", async () => {
    const store = kv();
    const install = vi.fn(async (): Promise<InstallResult> => ({ ok: true, path: "/data/bb-claude-code-mode" }));
    const wrappers = createWrappers({ install, kv: store, log });
    expect(await wrappers.pathFor("h1")).toBe("/data/bb-claude-code-mode");
    expect(await wrappers.pathFor("h1")).toBe("/data/bb-claude-code-mode");
    expect(install).toHaveBeenCalledTimes(1);
    expect(store.data.get(PATHS_KEY)).toEqual({ h1: "/data/bb-claude-code-mode" });
  });

  it("answers at once with a path an earlier load saved, and checks it again in the background", async () => {
    const store = kv({ [PATHS_KEY]: { h1: "/saved" } });
    let finish!: (result: InstallResult) => void;
    const install = vi.fn(() => new Promise<InstallResult>((resolve) => (finish = resolve)));
    const wrappers = createWrappers({ install, kv: store, log });
    expect(await wrappers.pathFor("h1")).toBe("/saved");
    expect(install).toHaveBeenCalledTimes(1);
    finish({ ok: true, path: "/saved" });
  });

  it("gives nothing for a machine whose first check fails or takes too long", async () => {
    const failing = createWrappers({ install: async () => ({ ok: false, reason: "Windows" }), kv: kv(), log });
    expect(await failing.pathFor("h1")).toBeNull();
    const slow = createWrappers({ install: () => new Promise<InstallResult>(() => undefined), kv: kv(), log, timeoutMs: 10 });
    expect(await slow.pathFor("h1")).toBeNull();
    const throwing = createWrappers({ install: async () => Promise.reject(new Error("offline")), kv: kv(), log });
    expect(await throwing.check("h1")).toEqual({ ok: false, reason: "offline" });
  });

  it("does not let a saved path stand in for a failed check when a new thread is decided, but keeps routing existing ones", async () => {
    const store = kv({ [PATHS_KEY]: { h1: "/saved" } });
    const wrappers = createWrappers({ install: async () => ({ ok: false, reason: "old Node no longer exists" }), kv: store, log });
    await wrappers.check("h1");
    expect(await wrappers.readiness("h1")).toEqual({ ok: false, reason: "old Node no longer exists" });
    expect(await wrappers.pathFor("h1")).toBe("/saved");
  });

  it("takes back an earlier success when a later check fails", async () => {
    let ok = true;
    const wrappers = createWrappers({ install: async () => (ok ? { ok: true, path: "/p" } : { ok: false, reason: "gone" }), kv: kv(), log });
    await wrappers.check("h1");
    expect(await wrappers.readiness("h1")).toEqual({ ok: true });
    ok = false;
    await wrappers.check("h1");
    expect(wrappers.isReady("h1")).toBe(false);
    expect(await wrappers.readiness("h1")).toEqual({ ok: false, reason: "gone" });
  });

  it("checks a machine never checked on this load before saying it is ready", async () => {
    const install = vi.fn(async (): Promise<InstallResult> => ({ ok: true, path: "/p" }));
    const wrappers = createWrappers({ install, kv: kv({ [PATHS_KEY]: { h1: "/p" } }), log });
    expect(await wrappers.readiness("h1")).toEqual({ ok: true });
    expect(install).toHaveBeenCalledTimes(1);
  });
});
