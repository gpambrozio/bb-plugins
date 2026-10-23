import { describe, expect, it } from "vitest";

import { checkAutoCompact, type AutoCompactDeps } from "./autocompact";
import { withMateLock } from "./mate";
import { autoCompactRules, defaultSettings, type AutoCompactRule, type AutoCompactRules } from "./settings";
import { createStore, type Store } from "./store";
import { fakeLog, fakeThreads, memoryKv, type FakeLog, type FakeThreads } from "./testing/fakes";

const MINUTE = 60_000;
const NOW = 100 * 24 * 60 * MINUTE;

/** The crew's rule from the default settings: off, above 200,000 tokens, after 60 minutes. */
const DEFAULT_RULE = autoCompactRules(defaultSettings()).crew;
const on = (fields: Partial<AutoCompactRule> = {}): AutoCompactRule => ({ ...DEFAULT_RULE, enabled: true, ...fields });
const off = (): AutoCompactRule => ({ ...DEFAULT_RULE });

interface Harness {
  threads: FakeThreads;
  store: Store;
  log: FakeLog;
  deps: AutoCompactDeps;
  mateId: string;
  /** How often the first mate's compaction took the mate lock. */
  locks: () => number;
  setNow: (now: number) => void;
}

async function harness(rules: Partial<AutoCompactRules> = {}, kv = memoryKv()): Promise<Harness> {
  const threads = fakeThreads();
  const store = createStore(kv);
  const log = fakeLog();
  const mate = threads.add({ title: "First mate" });
  await store.setMateThreadId(mate.id);
  let now = NOW;
  let locks = 0;
  const deps: AutoCompactDeps = {
    threads,
    store,
    rules: async () => ({ mate: off(), crew: off(), ...rules }),
    withMateLock: (work) => {
      locks += 1;
      return withMateLock(work);
    },
    now: () => now,
    log,
  };
  return {
    threads,
    store,
    log,
    deps,
    mateId: mate.id,
    locks: () => locks,
    setNow: (next) => {
      now = next;
    },
  };
}

/** A crewmate whose last turn ended `idleMinutes` ago with `usedTokens` in context. */
function crewmate(h: Harness, idleMinutes: number, usedTokens: number, title = "Fix the bug") {
  const thread = h.threads.add({ title, parentThreadId: h.mateId });
  h.threads.runTurn(thread.id, NOW - idleMinutes * MINUTE);
  h.threads.setUsage(thread.id, { usedTokens, estimated: false });
  return thread;
}

describe("checkAutoCompact", () => {
  it("compacts an idle crewmate over the threshold and logs the tokens and idle minutes", async () => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);

    const done = await checkAutoCompact(h.deps);

    expect(done).toEqual({ threadId: thread.id, role: "crew", usage: { usedTokens: 250_000, estimated: false }, idleMinutes: 75, ok: true });
    expect(h.threads.callsTo("compact")).toEqual([[thread.id]]);
    expect(h.log.infos).toEqual([`Autocompact compacted crewmate ${thread.id} "Fix the bug": 250,000 tokens, idle 75 minutes.`]);
  });

  it("says when bb's figure is an estimate", async () => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);
    h.threads.setUsage(thread.id, { usedTokens: 250_000, estimated: true });

    await checkAutoCompact(h.deps);

    expect(h.log.infos[0]).toContain("250,000 tokens (estimated), idle 75 minutes");
  });

  it("leaves a thread at or under the token threshold", async () => {
    const h = await harness({ crew: on({ minTokens: 200_000 }) });
    crewmate(h, 75, 200_000);
    crewmate(h, 75, 10_000);

    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.threads.callsTo("compact")).toEqual([]);
  });

  it("waits until the thread has been idle for the whole idle time", async () => {
    const h = await harness({ crew: on({ idleMinutes: 60 }) });
    const thread = crewmate(h, 59, 250_000);

    expect(await checkAutoCompact(h.deps)).toBeNull();

    h.setNow(NOW + MINUTE);
    expect((await checkAutoCompact(h.deps))?.threadId).toBe(thread.id);
  });

  it("measures idle time from the end of the last turn, not an earlier one", async () => {
    const h = await harness({ crew: on({ idleMinutes: 60 }) });
    const thread = crewmate(h, 600, 250_000);
    h.threads.runTurn(thread.id, NOW - 5 * MINUTE);

    expect(await checkAutoCompact(h.deps)).toBeNull();
  });

  it("leaves a thread that has never finished a turn", async () => {
    const h = await harness({ crew: on() });
    const thread = h.threads.add({ parentThreadId: h.mateId });
    h.threads.setUsage(thread.id, { usedTokens: 250_000, estimated: false });

    expect(await checkAutoCompact(h.deps)).toBeNull();
  });

  it("leaves a thread with no usage figure", async () => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);
    h.threads.setUsage(thread.id, null);

    expect(await checkAutoCompact(h.deps)).toBeNull();
  });

  it.each([
    ["mid-turn", (h: Harness, id: string) => h.threads.set(id, { status: "active" })],
    ["starting a turn", (h: Harness, id: string) => h.threads.set(id, { status: "starting" })],
    ["errored", (h: Harness, id: string) => h.threads.set(id, { status: "error" })],
    ["with a message queued", (h: Harness, id: string) => h.threads.setRest(id, { queuedMessages: 1 })],
    ["waiting on a permission, question or plan", (h: Harness, id: string) => h.threads.setRest(id, { pendingInteractions: 1 })],
    ["with a background agent running", (h: Harness, id: string) => h.threads.setRest(id, { backgroundAgents: 1 })],
    ["waiting for its machine", (h: Harness, id: string) => h.threads.setRest(id, { runtimeStatus: "waiting-for-host" })],
    ["archived", (h: Harness, id: string) => h.threads.archiveNow(id)],
  ])("never compacts a crewmate %s", async (_label, make) => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);
    make(h, thread.id);

    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.threads.callsTo("compact")).toEqual([]);
  });

  it("does nothing, and reads nothing of bb, with both rules off", async () => {
    const h = await harness();
    crewmate(h, 75, 250_000);
    h.threads.calls.length = 0;

    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.threads.calls).toEqual([]);
  });

  it("leaves the crew alone when only the first mate's rule is on, and the first mate when only the crew's is", async () => {
    const mateOnly = await harness({ mate: on() });
    crewmate(mateOnly, 75, 250_000);
    expect(await checkAutoCompact(mateOnly.deps)).toBeNull();

    const crewOnly = await harness({ crew: on() });
    crewOnly.threads.runTurn(crewOnly.mateId, NOW - 75 * MINUTE);
    crewOnly.threads.setUsage(crewOnly.mateId, { usedTokens: 250_000, estimated: false });
    expect(await checkAutoCompact(crewOnly.deps)).toBeNull();
  });

  it("compacts the first mate by its own rule, under the mate lock", async () => {
    const h = await harness({ mate: on({ minTokens: 100_000, idleMinutes: 30 }), crew: on() });
    h.threads.runTurn(h.mateId, NOW - 31 * MINUTE);
    h.threads.setUsage(h.mateId, { usedTokens: 150_000, estimated: false });

    const done = await checkAutoCompact(h.deps);

    expect(done).toMatchObject({ threadId: h.mateId, role: "mate", idleMinutes: 31 });
    expect(h.locks()).toBe(1);
    expect(h.log.infos).toEqual([`Autocompact compacted the first mate ${h.mateId} "First mate": 150,000 tokens, idle 31 minutes.`]);
  });

  it("applies the crew's rule to crew, not the first mate's", async () => {
    const h = await harness({ mate: on({ minTokens: 100_000 }), crew: on({ minTokens: 300_000 }) });
    crewmate(h, 75, 250_000);

    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.locks()).toBe(0);
  });

  it("does nothing with no first mate aboard, or one bb no longer has", async () => {
    const h = await harness({ mate: on(), crew: on() });
    crewmate(h, 75, 250_000);
    h.threads.archiveNow(h.mateId);
    expect(await checkAutoCompact(h.deps)).toBeNull();

    await h.store.setMateThreadId(null);
    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.threads.callsTo("compact")).toEqual([]);
  });

  it("compacts at most one thread per check", async () => {
    const h = await harness({ crew: on() });
    const first = crewmate(h, 75, 250_000, "One");
    const second = crewmate(h, 75, 250_000, "Two");

    expect((await checkAutoCompact(h.deps))?.threadId).toBe(first.id);
    expect(h.threads.callsTo("compact")).toEqual([[first.id]]);
    expect((await checkAutoCompact(h.deps))?.threadId).toBe(second.id);
    expect(h.threads.callsTo("compact")).toEqual([[first.id], [second.id]]);
  });

  it("does not compact a thread that woke between the check and the compaction", async () => {
    const h = await harness({ mate: on() });
    h.threads.runTurn(h.mateId, NOW - 75 * MINUTE);
    h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false });
    h.deps.withMateLock = (work) => {
      h.threads.setRest(h.mateId, { queuedMessages: 1 });
      return withMateLock(work);
    };

    expect(await checkAutoCompact(h.deps)).toBeNull();
    expect(h.threads.callsTo("compact")).toEqual([]);
  });

  describe("once per idle stretch", () => {
    it("does not compact again while the usage stays high, nor after the compaction's own turn", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 250_000);
      await checkAutoCompact(h.deps);

      // Usage that has not been measured again since.
      h.setNow(NOW + 10 * MINUTE);
      expect(await checkAutoCompact(h.deps)).toBeNull();

      // The compaction's own turn ends, and the figure is still stale.
      h.threads.runTurn(thread.id, NOW + 11 * MINUTE);
      h.setNow(NOW + 200 * MINUTE);
      expect(await checkAutoCompact(h.deps)).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([[thread.id]]);
    });

    it("compacts again once the thread has run a turn of its own and sat idle again", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 250_000);
      await checkAutoCompact(h.deps);
      h.threads.runTurn(thread.id, NOW + 1 * MINUTE); // the compaction
      h.threads.runTurn(thread.id, NOW + 30 * MINUTE); // the captain's next request

      h.setNow(NOW + 89 * MINUTE);
      expect(await checkAutoCompact(h.deps)).toBeNull();
      h.setNow(NOW + 90 * MINUTE);
      expect((await checkAutoCompact(h.deps))?.threadId).toBe(thread.id);
      expect(h.threads.callsTo("compact")).toEqual([[thread.id], [thread.id]]);
    });

    it("does not retry a refused compaction in the same idle stretch, and does after the next turn", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 250_000);
      h.threads.failNext("compact", new Error("compaction is not supported"));

      expect(await checkAutoCompact(h.deps)).toMatchObject({ threadId: thread.id, ok: false });
      expect(h.log.warnings).toEqual([
        `Autocompact could not compact crewmate ${thread.id} "Fix the bug": compaction is not supported. It is tried again after its next turn.`,
      ]);
      expect(h.log.infos).toEqual([]);
      expect(await checkAutoCompact(h.deps)).toBeNull();

      h.threads.runTurn(thread.id, NOW - 61 * MINUTE);
      expect((await checkAutoCompact(h.deps))?.ok).toBe(true);
    });

    it("keeps its marks across a restart, in the store", async () => {
      const kv = memoryKv();
      const before = await harness({ crew: on() }, kv);
      const thread = crewmate(before, 75, 250_000);
      await checkAutoCompact(before.deps);

      // A new plugin instance over the same storage, reading the same bb.
      const after = { ...before.deps, store: createStore(kv) };
      expect(await checkAutoCompact(after)).toBeNull();
      expect(before.threads.callsTo("compact")).toEqual([[thread.id]]);
    });

    it("forgets the marks of threads that are no longer the first mate's crew", async () => {
      const h = await harness({ crew: on() });
      const ended = crewmate(h, 75, 250_000);
      await checkAutoCompact(h.deps);
      expect(Object.keys(await h.store.compactions())).toEqual([ended.id]);

      h.threads.archiveNow(ended.id);
      await checkAutoCompact(h.deps);
      expect(await h.store.compactions()).toEqual({});
    });
  });

  it("logs a thread whose reads fail and goes on to the next", async () => {
    const h = await harness({ crew: on() });
    const broken = crewmate(h, 75, 250_000, "Broken");
    const fine = crewmate(h, 75, 250_000, "Fine");
    h.threads.failNext("lastTurnEnd", new Error("bb is busy"));

    expect((await checkAutoCompact(h.deps))?.threadId).toBe(fine.id);
    expect(h.log.warnings).toEqual([`Autocompact could not check crewmate ${broken.id} "Broken": bb is busy`]);
  });
});
