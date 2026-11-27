import { describe, expect, it, vi } from "vitest";

import type { CodeModeRecord } from "../shared/record";
import { createRecords } from "./records";

function setup(initial: Record<string, Record<string, unknown>> = {}) {
  const stored = new Map(Object.entries(initial));
  const deps = {
    read: vi.fn(async (threadId: string) => stored.get(threadId) ?? null),
    readMany: vi.fn(async (threadIds: readonly string[]) => new Map(threadIds.flatMap((id) => (stored.has(id) ? [[id, stored.get(id)!] as const] : [])))),
    write: vi.fn(async (threadId: string, record: CodeModeRecord) => {
      stored.set(threadId, { ...(stored.get(threadId) ?? {}), codeMode: record });
    }),
    changed: vi.fn(),
    now: () => 42,
    log: { warn: vi.fn() },
  };
  return { records: createRecords(deps), deps, stored };
}

describe("the sticky record", () => {
  it("is written once, at the first decision, and never changed", async () => {
    const { records, deps } = setup();
    const first = await records.decideOnce("t", async () => ({ record: records.make("on", "first"), store: true }));
    const second = await records.decideOnce("t", async () => ({ record: records.make("off", "second"), store: true }));
    expect(first).toEqual({ codeMode: "on", reason: "first", decidedAt: 42 });
    expect(second).toEqual(first);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.changed).toHaveBeenCalledWith("t");
  });

  it("keeps a record stored by an earlier load", async () => {
    const { records, deps } = setup({ t: { codeMode: { codeMode: "on", reason: "earlier", decidedAt: 1 } } });
    const decider = vi.fn(async () => ({ record: records.make("off", "now"), store: true }));
    expect(await records.decideOnce("t", decider)).toMatchObject({ codeMode: "on", reason: "earlier" });
    expect(decider).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent deciders decide", async () => {
    const { records, deps } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = records.decideOnce("t", async () => {
      await gate;
      return { record: records.make("on", "slow"), store: true };
    });
    const fast = records.decideOnce("t", async () => ({ record: records.make("off", "fast"), store: true }));
    release();
    expect(await slow).toMatchObject({ codeMode: "on" });
    expect(await fast).toMatchObject({ codeMode: "on" });
    expect(deps.write).toHaveBeenCalledTimes(1);
  });

  it("remembers a thread to leave alone without writing anything", async () => {
    const { records, deps } = setup();
    expect(await records.decideOnce("old", async () => ({ record: null }))).toBeNull();
    const decider = vi.fn(async () => ({ record: records.make("on", "later"), store: true }));
    expect(await records.decideOnce("old", decider)).toBeNull();
    expect(decider).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("reads an unreadable record as off and says so", async () => {
    const { records, deps } = setup({ t: { codeMode: "yes please" } });
    expect(await records.get("t")).toMatchObject({ codeMode: "off" });
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("reads many threads in batches of 200, from the cache when it can", async () => {
    const initial: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 450; i += 1) initial[`t${i}`] = { codeMode: { codeMode: i % 2 ? "on" : "off", reason: "x", decidedAt: 1 } };
    const { records, deps } = setup(initial);
    const ids = [...Object.keys(initial), "none"];
    const found = await records.getMany(ids);
    expect(found.get("t1")?.codeMode).toBe("on");
    expect(found.get("t2")?.codeMode).toBe("off");
    expect(found.get("none")).toBeNull();
    expect(deps.readMany).toHaveBeenCalledTimes(3);
    await records.getMany(["t1", "t2"]);
    expect(deps.readMany).toHaveBeenCalledTimes(3);
  });
});
