import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isNoOpReply, quietShipshape } from "./quiet-shipshape";
import { fakeLog, fakeThreads, memoryStore } from "./testing/fakes";

const MATE = "thr_mate";
const SHIPSHAPE = "Captain, shipshape.";

describe("isNoOpReply", () => {
  it("matches the charter's no-op reply, with any case, spacing, comma and closing punctuation", () => {
    for (const text of [
      "Captain, shipshape.",
      "  Captain, shipshape.\n",
      "captain, SHIPSHAPE",
      "Captain,   shipshape!",
      "Captain shipshape.",
      "Captain, shipshape...",
      "Captain,\nshipshape.",
    ]) {
      expect(isNoOpReply(text), text).toBe(true);
    }
  });

  it("does not match a reply that says anything more", () => {
    for (const text of [
      "Captain, shipshape. PR ready for review, captain: https://github.com/you/web/pull/42",
      "Captain, shipshape — one crewmate is still running.",
      "Shipshape.",
      "Captain, all shipshape.",
      "**Captain, shipshape.**",
      "Aye, captain, shipshape.",
      "",
    ]) {
      expect(isNoOpReply(text), text).toBe(false);
    }
  });

  it("matches the words the charter tells the first mate to use", async () => {
    const charter = await readFile(join(import.meta.dirname, "../templates/data/charter.md"), "utf8");
    const quoted = /Reply exactly `([^`]+)` for a true no-op/u.exec(charter)?.[1];
    expect(quoted).toBeDefined();
    expect(isNoOpReply(quoted as string)).toBe(true);
  });
});

describe("quietShipshape", () => {
  async function setup(options: { enabled?: boolean } = {}) {
    const threads = fakeThreads();
    threads.add({ id: MATE, status: "idle" });
    threads.setText(MATE, SHIPSHAPE);
    const store = memoryStore();
    await store.setMateThreadId(MATE);
    const log = fakeLog();
    const state = { enabled: options.enabled ?? true };
    const deps = { threads, store, enabled: async () => state.enabled, log };
    return { threads, store, log, state, run: (threadId: string, text: string | null) => quietShipshape(deps, threadId, text) };
  }

  it("marks the first mate's no-op turn read, so bb's sender skips it", async () => {
    const { threads, run } = await setup();
    expect(await run(MATE, SHIPSHAPE)).toBe(true);
    expect(threads.callsTo("markRead")).toEqual([[MATE]]);
  });

  it("leaves every other reply, and a turn with no text, to bb", async () => {
    const { threads, run } = await setup();
    threads.setText(MATE, "PR ready for review, captain.");
    expect(await run(MATE, "PR ready for review, captain.")).toBe(false);
    expect(await run(MATE, "Captain, shipshape. One crewmate is still running.")).toBe(false);
    expect(await run(MATE, null)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
  });

  it("asks bb nothing while the setting is off", async () => {
    const { threads, run } = await setup({ enabled: false });
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.calls).toEqual([]);
  });

  it("touches only the first mate's own thread", async () => {
    const { threads, store, run } = await setup();
    threads.add({ id: "thr_crew", parentThreadId: MATE, status: "idle" });
    threads.setText("thr_crew", SHIPSHAPE);
    expect(await run("thr_crew", SHIPSHAPE)).toBe(false);

    await store.setMateThreadId(null);
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
  });

  it("never marks read a turn with a question or an approval waiting", async () => {
    const { threads, run } = await setup();
    threads.setPendingInteractions(MATE, 1);
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
  });

  it("leaves it when the no-op is no longer the latest turn", async () => {
    const { threads, run } = await setup();
    // A message is waiting, so another turn follows at once.
    threads.setRest(MATE, { queuedMessages: 1 });
    expect(await run(MATE, SHIPSHAPE)).toBe(false);

    // Another turn has started.
    threads.setRest(MATE, { queuedMessages: 0 });
    threads.setStatus(MATE, "active");
    expect(await run(MATE, SHIPSHAPE)).toBe(false);

    // Another turn has already ended with something to say.
    threads.setStatus(MATE, "idle");
    threads.setText(MATE, "PR ready for review, captain.");
    expect(await run(MATE, SHIPSHAPE)).toBe(false);

    // Its machine is not connected.
    threads.setText(MATE, SHIPSHAPE);
    threads.setRest(MATE, { runtimeStatus: "waiting-for-host" });
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
  });

  it("leaves a first mate bb no longer has", async () => {
    const { threads, run } = await setup();
    threads.archiveNow(MATE);
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
  });

  it("logs a failed mark and lets bb notify", async () => {
    const { threads, log, run } = await setup();
    threads.failNext("markRead", new Error("bb is busy"));
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(log.warnings).toEqual(['Could not mark the first mate\'s "Captain, shipshape." turn read, so bb notifies of it: bb is busy']);
  });

  it("logs a failed read and marks nothing", async () => {
    const { threads, log, run } = await setup();
    threads.failNext("restState", new Error("bb is down"));
    expect(await run(MATE, SHIPSHAPE)).toBe(false);
    expect(threads.callsTo("markRead")).toEqual([]);
    expect(log.warnings).toHaveLength(1);
  });
});
