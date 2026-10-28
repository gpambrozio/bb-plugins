import { describe, expect, it } from "vitest";

import { checkAutoCompact, FailureLog, type AutoCompactDeps } from "./autocompact";
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
  /** Aborts the check's signal, as the service stopping would. */
  abort: () => void;
}

async function harness(rules: Partial<AutoCompactRules> = {}, kv = memoryKv()): Promise<Harness> {
  const threads = fakeThreads();
  const store = createStore(kv);
  const log = fakeLog();
  const mate = threads.add({ title: "First mate" });
  await store.setMateThreadId(mate.id);
  let now = NOW;
  let locks = 0;
  const controller = new AbortController();
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
    failures: new FailureLog(log),
    signal: controller.signal,
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
    abort: () => controller.abort(),
  };
}

/** A crewmate whose last turn ended `idleMinutes` ago with `usedTokens` in context. */
function crewmate(h: Harness, idleMinutes: number, usedTokens: number, title = "Fix the bug") {
  const thread = h.threads.add({ title, parentThreadId: h.mateId });
  h.threads.runTurn(thread.id, NOW - idleMinutes * MINUTE);
  h.threads.setUsage(thread.id, { usedTokens, estimated: false, cacheExpiresAt: null });
  return thread;
}

describe("checkAutoCompact", () => {
  it("compacts an idle crewmate over the threshold and logs the tokens and idle minutes", async () => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);

    const done = await checkAutoCompact(h.deps);

    expect(done).toEqual({ threadId: thread.id, role: "crew", usage: { usedTokens: 250_000, estimated: false, cacheExpiresAt: null }, idleMinutes: 75, ok: true });
    expect(h.threads.callsTo("compact")).toEqual([[thread.id]]);
    expect(h.log.infos).toEqual([`Autocompact compacted crewmate ${thread.id} "Fix the bug": 250,000 tokens, idle 75 minutes.`]);
  });

  it("says when bb's figure is an estimate", async () => {
    const h = await harness({ crew: on() });
    const thread = crewmate(h, 75, 250_000);
    h.threads.setUsage(thread.id, { usedTokens: 250_000, estimated: true, cacheExpiresAt: null });

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

  it("waits for bb's prompt-cache deadline instead of the idle time when bb gives one", async () => {
    const h = await harness({ crew: on({ idleMinutes: 60 }) });
    const early = crewmate(h, 10, 250_000, "Early");
    h.threads.setUsage(early.id, { usedTokens: 250_000, estimated: false, cacheExpiresAt: NOW - 5 * MINUTE });
    const late = crewmate(h, 90, 250_000, "Late");
    h.threads.setUsage(late.id, { usedTokens: 250_000, estimated: false, cacheExpiresAt: NOW + MINUTE });

    const done = await checkAutoCompact(h.deps);
    expect(done?.threadId).toBe(early.id);
    expect(h.log.infos).toEqual([
      `Autocompact compacted crewmate ${early.id} "Early": 250,000 tokens, idle 10 minutes, past bb's prompt-cache deadline.`,
    ]);

    // The other one's cache is still warm, though it is long past the idle minutes.
    expect(await checkAutoCompact(h.deps)).toBeNull();
    h.setNow(NOW + MINUTE);
    expect((await checkAutoCompact(h.deps))?.threadId).toBe(late.id);
  });

  it("keeps the token threshold when bb's deadline has passed", async () => {
    const h = await harness({ crew: on({ minTokens: 200_000 }) });
    const thread = crewmate(h, 10, 150_000);
    h.threads.setUsage(thread.id, { usedTokens: 150_000, estimated: false, cacheExpiresAt: NOW - MINUTE });

    expect(await checkAutoCompact(h.deps)).toBeNull();
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
    h.threads.setUsage(thread.id, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });

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
    crewOnly.threads.setUsage(crewOnly.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
    expect(await checkAutoCompact(crewOnly.deps)).toBeNull();
  });

  it("compacts the first mate by its own rule, under the mate lock", async () => {
    const h = await harness({ mate: on({ minTokens: 100_000, idleMinutes: 30 }), crew: on() });
    h.threads.runTurn(h.mateId, NOW - 31 * MINUTE);
    h.threads.setUsage(h.mateId, { usedTokens: 150_000, estimated: false, cacheExpiresAt: null });

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
    h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
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
      expect(await h.store.compactionMarkIds()).toEqual([ended.id]);

      h.threads.archiveNow(ended.id);
      await checkAutoCompact(h.deps);
      expect(await h.store.compactionMarkIds()).toEqual([]);
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

  describe("the mark, written before the request (finding: a failed write)", () => {
    /** A kv whose writes of autocompact's marks reject from the `from`th one on. */
    function failingMarks(from = 1) {
      const kv = memoryKv();
      const set = kv.set.bind(kv);
      let writes = 0;
      kv.set = async (key, value) => {
        if (key.startsWith("autoCompaction:") && ++writes >= from) throw new Error("storage is full");
        return set(key, value);
      };
      return kv;
    }

    it("is in the store, as accepted, by the time the request reaches bb", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 250_000);
      const seen: unknown[] = [];
      const compact = h.threads.compact.bind(h.threads);
      h.threads.compact = async (id) => {
        seen.push(await h.store.compactionMark(id));
        return compact(id);
      };

      await checkAutoCompact(h.deps);

      expect(seen).toEqual([{ afterSeq: expect.any(Number), ok: true, at: NOW }]);
      expect(h.threads.callsTo("compact")).toEqual([[thread.id]]);
    });

    it("stops the compaction when it cannot be saved, and sends none to any other thread", async () => {
      const h = await harness({ crew: on() }, failingMarks());
      const first = crewmate(h, 75, 250_000, "One");
      const second = crewmate(h, 75, 250_000, "Two");

      expect(await checkAutoCompact(h.deps)).toBeNull();

      expect(h.threads.callsTo("compact")).toEqual([]);
      expect(h.log.warnings).toEqual([
        `Autocompact could not check crewmate ${first.id} "One": its mark could not be saved, so it was not compacted: storage is full`,
        `Autocompact could not check crewmate ${second.id} "Two": its mark could not be saved, so it was not compacted: storage is full`,
      ]);
    });

    it("ends the check once a request is sent, even when noting bb's refusal fails, and keeps the stricter mark", async () => {
      const h = await harness({ crew: on() }, failingMarks(2));
      const first = crewmate(h, 75, 250_000, "One");
      crewmate(h, 75, 250_000, "Two");
      h.threads.failNext("compact", new Error("compaction is not supported"));

      expect(await checkAutoCompact(h.deps)).toMatchObject({ threadId: first.id, ok: false });

      expect(h.threads.callsTo("compact")).toEqual([[first.id]]);
      expect(await h.store.compactionMark(first.id)).toMatchObject({ ok: true });
      expect(h.log.warnings).toContain(
        `Autocompact could not note that bb refused to compact ${first.id}, so it waits for two turns instead of one: storage is full`,
      );
    });

    it("keeps each thread's mark under its own key, so a large crew never meets kv's 256 KB limit on one value", async () => {
      const kv = memoryKv();
      const store = createStore(kv);
      for (let n = 0; n < 5_000; n += 1) await store.setCompactionMark(`thr_${n}`, { afterSeq: 1_000_000 + n, ok: true, at: NOW });

      expect(await store.compactionMarkIds()).toHaveLength(5_000);
      const largest = Math.max(...[...kv.entries.values()].map((value) => value.length));
      expect(largest).toBeLessThan(100);
      expect(await store.compactionMark("thr_4999")).toEqual({ afterSeq: 1_004_999, ok: true, at: NOW });
    });
  });

  describe("stopping (finding: work after the service is aborted)", () => {
    it("sends nothing when the service stops during a read", async () => {
      const h = await harness({ crew: on() });
      crewmate(h, 75, 250_000);
      const release = h.threads.hold("lastTurnEnd");

      const check = checkAutoCompact(h.deps);
      await new Promise((resolve) => setTimeout(resolve, 5));
      h.abort();
      release();

      expect(await check).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([]);
      expect(h.log.warnings).toEqual([]);
    });

    it("sends nothing when the service stops while the check waits for the mate lock", async () => {
      const h = await harness({ mate: on() });
      h.threads.runTurn(h.mateId, NOW - 75 * MINUTE);
      h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
      let unlock!: () => void;
      const held = withMateLock(() => new Promise<void>((resolve) => (unlock = resolve)));

      const check = checkAutoCompact(h.deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.abort();
      unlock();
      await held;

      expect(await check).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([]);
      expect(await h.store.compactionMark(h.mateId)).toBeNull();
    });

    it("settles at once when stopped while something else holds the mate lock, and the abandoned wait sends nothing later", async () => {
      const h = await harness({ mate: on() });
      h.threads.runTurn(h.mateId, NOW - 75 * MINUTE);
      h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
      let unlock!: () => void;
      const held = withMateLock(() => new Promise<void>((resolve) => (unlock = resolve)));

      const check = checkAutoCompact(h.deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.abort();

      // Settles while the lock is still held.
      expect(await check).toBeNull();

      unlock();
      await held;
      await withMateLock(async () => undefined);
      expect(h.threads.callsTo("compact")).toEqual([]);
      expect(await h.store.compactionMark(h.mateId)).toBeNull();
    });

    it("visits no further thread once stopped", async () => {
      const h = await harness({ crew: on() });
      crewmate(h, 75, 250_000, "One");
      crewmate(h, 75, 250_000, "Two");
      h.abort();

      expect(await checkAutoCompact(h.deps)).toBeNull();
      expect(h.threads.callsTo("lastTurnEnd")).toEqual([]);
    });
  });

  describe("the first mate changing (finding: a release or adoption that came first)", () => {
    /** Runs `change` under the mate lock, as release or adopt would, before the check's own turn there. */
    function changeFirst(h: Harness, change: () => Promise<void>) {
      h.deps.withMateLock = (work) => {
        void withMateLock(change);
        return withMateLock(work);
      };
    }

    it("leaves a first mate released before the check took the lock", async () => {
      const h = await harness({ mate: on(), crew: on() });
      h.threads.runTurn(h.mateId, NOW - 75 * MINUTE);
      h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
      changeFirst(h, () => h.store.setMateThreadId(null));

      expect(await checkAutoCompact(h.deps)).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([]);
      expect(await h.store.compactionMark(h.mateId)).toBeNull();
    });

    it("leaves the old first mate and its crew alone when another was adopted first", async () => {
      const h = await harness({ mate: on(), crew: on() });
      h.threads.runTurn(h.mateId, NOW - 75 * MINUTE);
      h.threads.setUsage(h.mateId, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
      crewmate(h, 75, 250_000);
      const adopted = h.threads.add({ title: "New first mate" });
      changeFirst(h, () => h.store.setMateThreadId(adopted.id));

      expect(await checkAutoCompact(h.deps)).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([]);
    });

    it("leaves a crewmate that is no longer the first mate's child", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 250_000);
      changeFirst(h, async () => h.threads.set(thread.id, { parentThreadId: "thr_elsewhere" }));

      expect(await checkAutoCompact(h.deps)).toBeNull();
      expect(h.threads.callsTo("compact")).toEqual([]);
    });

    it("compacts crew under the mate lock too", async () => {
      const h = await harness({ crew: on() });
      crewmate(h, 75, 250_000);

      await checkAutoCompact(h.deps);
      expect(h.locks()).toBe(1);
    });
  });

  describe("repeated failures (finding: a warning every minute)", () => {
    it("warns once while a thread's read keeps failing the same way, and again after it recovers", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 10_000);
      const warning = `Autocompact could not check crewmate ${thread.id} "Fix the bug": bb is busy`;

      for (let n = 0; n < 3; n += 1) {
        h.threads.failNext("lastTurnEnd", new Error("bb is busy"));
        await checkAutoCompact(h.deps);
      }
      expect(h.log.warnings).toEqual([warning]);

      await checkAutoCompact(h.deps); // recovers
      h.threads.failNext("lastTurnEnd", new Error("bb is busy"));
      await checkAutoCompact(h.deps);
      expect(h.log.warnings).toEqual([warning, warning]);
    });

    it("warns again when the failure changes", async () => {
      const h = await harness({ crew: on() });
      crewmate(h, 75, 10_000);
      h.threads.failNext("lastTurnEnd", new Error("bb is busy"));
      await checkAutoCompact(h.deps);
      h.threads.failNext("lastTurnEnd", new Error("bb went away"));
      await checkAutoCompact(h.deps);

      expect(h.log.warnings).toHaveLength(2);
    });

    it("warns once while the first mate and its crew cannot be read", async () => {
      const h = await harness({ crew: on() });
      for (let n = 0; n < 3; n += 1) {
        h.threads.failNext("children", new Error("bb is busy"));
        await checkAutoCompact(h.deps);
      }
      expect(h.log.warnings).toEqual(["Autocompact could not read the first mate and its crew: bb is busy"]);
    });

    it("forgets the failures of threads that are gone, and remembers a bounded number", async () => {
      const h = await harness({ crew: on() });
      const thread = crewmate(h, 75, 10_000);
      h.threads.failNext("lastTurnEnd", new Error("bb is busy"));
      await checkAutoCompact(h.deps);
      expect(h.deps.failures.size).toBe(1);

      h.threads.archiveNow(thread.id);
      await checkAutoCompact(h.deps);
      expect(h.deps.failures.size).toBe(0);

    });

    it("at its limit admits no new failure and evicts none, so nothing is logged again; a recovery makes room", () => {
      const log = fakeLog();
      const failures = new FailureLog(log, 3);
      for (let pass = 0; pass < 3; pass += 1) for (const key of ["a", "b", "c", "d", "e"]) failures.warn(key, `failed ${key}`);

      expect(failures.size).toBe(3);
      const summary = "Autocompact is failing for more than 3 threads; it logs no further failures until some recover.";
      expect(log.warnings).toEqual(["failed a", "failed b", "failed c", summary]);

      failures.clear("a");
      failures.warn("d", "failed d");
      failures.warn("e", "failed e");
      expect(log.warnings).toEqual(["failed a", "failed b", "failed c", summary, "failed d", summary]);
    });

    it("logs a crew of more failing threads than it remembers once, not on every check", async () => {
      const h = await harness({ crew: on() });
      for (let n = 0; n < 1_001; n += 1) crewmate(h, 75, 10_000, `Task ${n}`);
      const lastTurnEnd = h.threads.lastTurnEnd.bind(h.threads);
      h.threads.lastTurnEnd = async (id, signal) => {
        await lastTurnEnd(id, signal);
        throw new Error("bb is busy");
      };

      const counts: number[] = [];
      for (let check = 0; check < 3; check += 1) {
        const before = h.log.warnings.length;
        await checkAutoCompact(h.deps);
        counts.push(h.log.warnings.length - before);
      }

      // The first 1,000 threads are logged one by one, the 1,001st only in the summary line.
      expect(counts).toEqual([1_001, 0, 0]);
      expect(h.log.warnings.at(-1)).toBe("Autocompact is failing for more than 1000 threads; it logs no further failures until some recover.");
    });
  });
});
