import { describe, expect, it } from "vitest";

import { checkAutoCompact, FailureLog, type AutoCompactDeps } from "./autocompact";
import { sendCompactingIfDue, type CompactFirstDeps } from "./compact-first";
import { withMateLock } from "./mate";
import type { SendMode } from "./ports";
import { autoCompactRules, defaultSettings, type AutoCompactRules } from "./settings";
import { createStore } from "./store";
import { fakeLog, fakeThreads, memoryKv } from "./testing/fakes";

const MINUTE = 60_000;
const NOW = 100 * 24 * 60 * MINUTE;
const RULE = { ...autoCompactRules(defaultSettings()).mate, enabled: true, minTokens: 200_000, idleMinutes: 60 };
const OFF = { ...RULE, enabled: false };

async function setup(rules: AutoCompactRules = { mate: RULE, crew: OFF }, kv = memoryKv()) {
  const threads = fakeThreads();
  const store = createStore(kv);
  const log = fakeLog();
  const mate = threads.add({ title: "First mate", status: "idle" });
  await store.setMateThreadId(mate.id);
  const lastTurn = threads.runTurn(mate.id, NOW - 90 * MINUTE);
  threads.setUsage(mate.id, { usedTokens: 250_000, estimated: false, cacheExpiresAt: null });
  const deps: CompactFirstDeps = { threads, store, rules: async () => rules, now: () => NOW, log };
  const send = (text: string) => (mode: SendMode) => threads.send(mate.id, text, mode);
  return { threads, store, log, mate, lastTurn, deps, send, kv };
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

  it("sends the message as asked when bb refuses to compact, and relaxes the mark to one turn", async () => {
    const { threads, store, log, mate, lastTurn, deps, send } = await setup();
    threads.failNext("send", new Error("HTTP 409: Thread is not idle"));

    await sendCompactingIfDue(deps, mate.id, "steer", send("steer it"));

    expect(threads.callsTo("send").map(([, , mode]) => mode)).toEqual(["compact-first", "steer"]);
    expect(threads.sent).toEqual([{ id: mate.id, text: "steer it", mode: "steer" }]);
    expect(await store.compactionMark(mate.id)).toEqual({ afterSeq: lastTurn.seq, ok: false, at: NOW });
    expect(log.warnings).toEqual([`bb would not compact ${mate.id} before a message to it, so the message goes as it is: HTTP 409: Thread is not idle`]);
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
    const { threads, store, log, mate, deps, send } = await setup();
    await sendCompactingIfDue(deps, mate.id, "auto", send("hello"));

    const check: AutoCompactDeps = { ...deps, store, withMateLock, failures: new FailureLog(log), signal: new AbortController().signal };
    expect(await checkAutoCompact(check)).toBeNull();
    expect(threads.callsTo("compact")).toEqual([]);
  });

  it("stops a check that found the thread due before the message's mark landed", async () => {
    const { threads, store, log, mate, lastTurn, deps } = await setup();
    const check: AutoCompactDeps = {
      ...deps,
      // The message's mark is written while the check waits for the lock.
      withMateLock: async (work) => {
        await store.setCompactionMark(mate.id, { afterSeq: lastTurn.seq, ok: true, at: NOW });
        return withMateLock(work);
      },
      failures: new FailureLog(log),
      signal: new AbortController().signal,
    };

    expect(await checkAutoCompact(check)).toBeNull();
    expect(threads.callsTo("compact")).toEqual([]);
  });
});
