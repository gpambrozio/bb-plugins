import { describe, expect, it } from "vitest";

import { checkAutoCompact, FailureLog, type AutoCompactDeps } from "./autocompact";
import { sendCompactingIfDue, type CompactFirstDeps } from "./compact-first";
import { withMateLock } from "./mate";
import { CompactFirstRefused, type SendMode } from "./ports";
import { autoCompactRules, defaultSettings, type AutoCompactRules } from "./settings";
import { createStore } from "./store";
import { fakeLog, fakeThreads, memoryKv } from "./testing/fakes";

const MINUTE = 60_000;
const NOW = 100 * 24 * 60 * MINUTE;
const RULE = { ...autoCompactRules(defaultSettings()).mate, enabled: true, minTokens: 200_000, idleMinutes: 60 };
const OFF = { ...RULE, enabled: false };

/** A promise and the function that settles it, for holding one step of a race where a test wants it. */
function barrier(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (open = resolve));
  return { reached, open };
}

async function setup(rules: AutoCompactRules = { mate: RULE, crew: OFF }, kv = memoryKv()) {
  const threads = fakeThreads();
  const store = createStore(kv);
  const log = fakeLog();
  const mate = threads.add({ title: "First mate", status: "idle" });
  await store.setMateThreadId(mate.id);
  const lastTurn = threads.runTurn(mate.id, NOW - 90 * MINUTE);
  threads.setUsage(mate.id, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
  /** Called whenever someone asks for the mate lock, before they get it. */
  let onLockRequest: () => void = () => {};
  const lock = <T>(work: () => Promise<T>): Promise<T> => {
    onLockRequest();
    return withMateLock(work);
  };
  const deps: CompactFirstDeps = { threads, store, rules: async () => rules, now: () => NOW, log, withMateLock: lock };
  const send = (text: string) => (mode: SendMode) => threads.send(mate.id, text, mode);
  const check = (): AutoCompactDeps => ({ ...deps, failures: new FailureLog(log), signal: new AbortController().signal });
  return {
    threads,
    store,
    log,
    mate,
    lastTurn,
    deps,
    send,
    kv,
    check,
    whenLockRequested: (listener: () => void) => (onLockRequest = listener),
  };
}

describe("sendCompactingIfDue", () => {
  it("asks bb to compact first when autocompact would compact the thread now, and marks the idle stretch", async () => {
    const { threads, store, log, mate, lastTurn, deps, send } = await setup();

    await sendCompactingIfDue(deps, mate.id, "auto", send("hello"));

    expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "compact-first" }]);
    expect(await store.compactionMark(mate.id)).toEqual({ afterSeq: lastTurn.seq, ok: true, at: NOW });
    expect(log.infos).toEqual([`Autocompact compacted ${mate.id} before delivering a message to it: 250,000 tokens, idle 90 minutes.`]);
  });

  it("sends as asked when the thread is not due, or its rule is off", async () => {
    const short = await setup();
    short.threads.setUsage(short.mate.id, { usedTokens: 100_000, estimated: false, cacheExpiresAt: null });
    await sendCompactingIfDue(short.deps, short.mate.id, "auto", short.send("small"));
    expect(short.threads.sent).toEqual([{ id: short.mate.id, text: "small", mode: "auto" }]);
    expect(await short.store.compactionMark(short.mate.id)).toBeNull();

    const busy = await setup();
    busy.threads.setRest(busy.mate.id, { queuedMessages: 1 });
    await sendCompactingIfDue(busy.deps, busy.mate.id, "queue-if-active", busy.send("queued"));
    expect(busy.threads.sent).toEqual([{ id: busy.mate.id, text: "queued", mode: "queue-if-active" }]);

    const off = await setup({ mate: OFF, crew: OFF });
    await sendCompactingIfDue(off.deps, off.mate.id, "auto", off.send("off"));
    expect(off.threads.sent).toEqual([{ id: off.mate.id, text: "off", mode: "auto" }]);
    // With autocompact off nothing about the thread is read.
    expect(off.threads.calls.map((call) => call.method)).toEqual(["send"]);
  });

  it("sends without compacting when its mark cannot be saved", async () => {
    const kv = memoryKv();
    const { threads, store, log, mate, deps, send } = await setup(undefined, kv);
    kv.set = async () => {
      throw new Error("kv is full");
    };

    await sendCompactingIfDue(deps, mate.id, "auto", send("hello"));

    expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "auto" }]);
    expect(await store.compactionMark(mate.id)).toBeNull();
    expect(log.warnings[0]).toContain("could not save its mark");
  });

  it("leaves nothing for the next check to compact", async () => {
    const { threads, mate, deps, send, check } = await setup();
    await sendCompactingIfDue(deps, mate.id, "auto", send("hello"));

    expect(await checkAutoCompact(check())).toBeNull();
    expect(threads.callsTo("compact")).toEqual([]);
  });

  describe("when bb fails the request", () => {
    it("sends the message as asked after a refusal, which comes before bb accepts anything, and relaxes the mark", async () => {
      const { threads, store, log, mate, lastTurn, deps } = await setup();
      const accepted: SendMode[] = [];
      const send = async (mode: SendMode) => {
        if (mode === "compact-first") throw new CompactFirstRefused("HTTP 409: Context can only be compacted while the thread is idle or errored");
        accepted.push(mode);
      };

      await sendCompactingIfDue(deps, mate.id, "steer", send);

      expect(accepted).toEqual(["steer"]);
      expect(threads.sent).toEqual([]);
      expect(await store.compactionMark(mate.id)).toEqual({ afterSeq: lastTurn.seq, ok: false, at: NOW });
      expect(log.warnings).toEqual([
        `bb would not compact ${mate.id} before a message to it, so the message goes as it is: HTTP 409: Context can only be compacted while the thread is idle or errored`,
      ]);
    });

    it("sends nothing again when the request failed after bb may have accepted it, and keeps the mark as accepted", async () => {
      const { store, mate, lastTurn, deps } = await setup();
      const accepted: SendMode[] = [];
      const send = async (mode: SendMode) => {
        accepted.push(mode);
        // bb took it, and the answer was lost on the way back.
        throw new TypeError("fetch failed");
      };

      await expect(sendCompactingIfDue(deps, mate.id, "auto", send)).rejects.toThrow("fetch failed");

      expect(accepted).toEqual(["compact-first"]);
      expect(await store.compactionMark(mate.id)).toEqual({ afterSeq: lastTurn.seq, ok: true, at: NOW });
    });
  });

  describe("racing the check, other messages and a change of first mate", () => {
    it("compacts first for one of two messages that arrive together, and sends the other as asked", async () => {
      const { threads, mate, deps, whenLockRequested } = await setup();
      // Both messages have had their first look before either goes on.
      const bothLooked = barrier();
      let requests = 0;
      whenLockRequested(() => {
        requests += 1;
        if (requests === 2) bothLooked.open();
      });
      const held = barrier();
      const sends: SendMode[] = [];
      const send = (text: string) => async (mode: SendMode) => {
        if (sends.push(mode) === 1) await held.reached;
        return threads.send(mate.id, text, mode);
      };

      const first = sendCompactingIfDue(deps, mate.id, "auto", send("one"));
      const second = sendCompactingIfDue(deps, mate.id, "auto", send("two"));
      // Without the lock the second message never waits, and finishes while the first is held.
      await Promise.race([bothLooked.reached, second]);
      held.open();
      await Promise.all([first, second]);

      expect(threads.sent.map((sent) => sent.mode).sort()).toEqual(["auto", "compact-first"]);
    });

    it("leaves the stretch to the check that compacted it after the message had looked", async () => {
      const kv = memoryKv();
      const { threads, mate, deps, check, whenLockRequested } = await setup(undefined, kv);
      // The check holds the lock with its mark write held until the message has had its first look.
      const checkMarking = barrier();
      const releaseMark = barrier();
      const set = kv.set.bind(kv);
      let held = false;
      kv.set = async (key, value) => {
        if (!held && key.startsWith("autoCompaction:")) {
          held = true;
          checkMarking.open();
          await releaseMark.reached;
        }
        await set(key, value);
      };
      const checking = checkAutoCompact({ ...check(), withMateLock: (work) => withMateLock(work) });
      await checkMarking.reached;

      const messageWaiting = barrier();
      whenLockRequested(() => messageWaiting.open());
      const sending = sendCompactingIfDue(deps, mate.id, "auto", (mode) => threads.send(mate.id, "hello", mode));
      await Promise.race([messageWaiting.reached, sending]);
      releaseMark.open();
      await Promise.all([checking, sending]);

      expect(threads.callsTo("compact")).toEqual([[mate.id]]);
      expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "auto" }]);
    });

    it("stops a check that assessed the stretch while a message was marking it", async () => {
      const kv = memoryKv();
      const { threads, mate, deps, check } = await setup(undefined, kv);
      // The message's mark write is held until the check has assessed and asked for the lock.
      const checkWaiting = barrier();
      const releaseMark = barrier();
      const set = kv.set.bind(kv);
      let held = false;
      kv.set = async (key, value) => {
        if (!held && key.startsWith("autoCompaction:")) {
          held = true;
          await releaseMark.reached;
        }
        await set(key, value);
      };
      const lockedCheck: AutoCompactDeps = {
        ...check(),
        withMateLock: (work) => {
          checkWaiting.open();
          return withMateLock(work);
        },
      };

      const sending = sendCompactingIfDue(deps, mate.id, "auto", (mode) => threads.send(mate.id, "hello", mode));
      // Let the message reach its held mark write before the check starts.
      while (!held) await new Promise((resolve) => setTimeout(resolve, 0));
      const checking = checkAutoCompact(lockedCheck);
      await Promise.race([checkWaiting.reached, checking]);
      releaseMark.open();
      await Promise.all([sending, checking]);

      expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "compact-first" }]);
      expect(threads.callsTo("compact")).toEqual([]);
    });

    it("sends as asked when a turn of bb's own ended while the message was assessing under the lock", async () => {
      const { threads, store, mate, deps, whenLockRequested } = await setup();
      // The under-lock assessment's context read is held; a message sent straight through bb runs a whole
      // turn meanwhile, so the thread is at rest again, but one minute after a turn, not ninety.
      let release: () => void = () => {};
      whenLockRequested(() => (release = threads.hold("contextUsage")));
      const underLockRead = async () => {
        while (threads.callsTo("contextUsage").length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
      };

      const sending = sendCompactingIfDue(deps, mate.id, "auto", (mode) => threads.send(mate.id, "hello", mode));
      // The second context read is the one under the lock: by then it has read the last turn.
      await underLockRead();
      threads.runTurn(mate.id, NOW - MINUTE);
      release();
      await sending;

      expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "auto" }]);
      expect(await store.compactionMark(mate.id)).toBeNull();
    });

    it("sends as asked to a first mate released while the message waited for the lock", async () => {
      const { threads, store, mate, deps, whenLockRequested } = await setup();
      const releasing = barrier();
      const messageWaiting = barrier();
      whenLockRequested(() => messageWaiting.open());
      // A release holds the lock until the message has had its first look and asked for it.
      const release = withMateLock(async () => {
        await releasing.reached;
        await store.setMateThreadId(null);
      });

      const sending = sendCompactingIfDue(deps, mate.id, "auto", (mode) => threads.send(mate.id, "hello", mode));
      await Promise.race([messageWaiting.reached, sending]);
      releasing.open();
      await Promise.all([release, sending]);

      expect(threads.sent).toEqual([{ id: mate.id, text: "hello", mode: "auto" }]);
      expect(await store.compactionMark(mate.id)).toBeNull();
    });
  });
});
