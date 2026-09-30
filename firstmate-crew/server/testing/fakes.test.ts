import { describe, expect, it } from "vitest";

import { fakeThreads } from "./fakes";

describe("FakeThreads", () => {
  it("records a send only once the thread exists", async () => {
    const threads = fakeThreads();
    await expect(threads.send("thr_missing", "hi", "auto")).rejects.toThrow("404");
    expect(threads.sent).toEqual([]);
    expect(threads.callsTo("send")).toEqual([["thr_missing", "hi", "auto"]]);
  });

  it("failNext makes the next call to that method reject, once", async () => {
    const threads = fakeThreads();
    const thread = threads.add();
    threads.failNext("lastText", new Error("boom"));
    await expect(threads.lastText(thread.id)).rejects.toThrow("boom");
    await expect(threads.lastText(thread.id)).resolves.toBeNull();
  });

  it("failSpawn still fails the next spawn", async () => {
    const threads = fakeThreads();
    threads.failSpawn(new Error("no room"));
    await expect(threads.spawn({ projectId: "p", title: "t", prompt: "x", environment: { kind: "worktree" }, metadata: {} })).rejects.toThrow("no room");
    expect(threads.spawned).toEqual([]);
  });
});
