import { describe, expect, it } from "vitest";

import { MAX_WORDS_CHARS, RateLimit, SendGate, TRANSCRIPT_WAIT_MS, UtteranceLog, saidYes } from "./policy";
import { FakeClock, settle } from "./testing/fakes";

describe("saidYes", () => {
  it.each(["Yes.", "yeah, approve it", "Go ahead", "OK, do it", "Confirmed.", "Sure, send it"])("takes %j as a yes", (words) => {
    expect(saidYes(words)).toBe(true);
  });

  it.each(["No.", "No, don't approve it", "Yes, but wait", "not yet", "I'm not sure", "Hold on", "deny it", "What does it do?", "", null])(
    "does not take %j as a yes",
    (words) => {
      expect(saidYes(words)).toBe(false);
    },
  );

  it("reads a curly apostrophe like a straight one", () => {
    expect(saidYes("Yes… actually, don’t")).toBe(false);
  });
});

describe("UtteranceLog", () => {
  it("gives what was said between two moments, word for word and in order", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.committed("a");
    log.transcribed("a", "before");
    const from = clock.now();
    await clock.advance(1_000);
    log.committed("b");
    log.transcribed("b", " Use the second one. ");
    await clock.advance(1_000);
    log.committed("c");
    log.transcribed("c", "With tests.");
    const to = clock.now();
    await clock.advance(1_000);
    log.committed("d");
    log.transcribed("d", "after");
    expect(await log.between(from, to)).toBe("Use the second one. With tests.");
  });

  it("waits for a transcript on its way, and gives up after a while", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    const from = clock.now();
    await clock.advance(10);
    log.committed("a");
    const reading = log.between(from, clock.now());
    await settle();
    log.transcribed("a", "the first");
    expect(await reading).toBe("the first");

    await clock.advance(10);
    log.committed("b");
    const stuck = log.between(from, clock.now());
    await clock.advance(TRANSCRIPT_WAIT_MS);
    expect(await stuck).toBe("the first");
  });

  it("answers null for nothing said, and keeps to the cap by dropping the oldest", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    const from = clock.now();
    expect(await log.between(from, clock.now())).toBeNull();
    for (const id of ["a", "b", "c"]) {
      await clock.advance(10);
      log.transcribed(id, `${id}`.repeat(MAX_WORDS_CHARS / 2));
    }
    const words = await log.between(from, clock.now());
    expect(words?.startsWith("c")).toBe(true);
    expect(words?.length).toBeLessThanOrEqual(MAX_WORDS_CHARS);
  });
});

describe("limits", () => {
  it("rate-limit within a window", async () => {
    const clock = new FakeClock();
    const limit = new RateLimit(clock, 2, 1_000);
    expect([limit.take(), limit.take(), limit.take()]).toEqual([true, true, false]);
    await clock.advance(1_000);
    expect(limit.take()).toBe(true);
  });

  it("refuse a second send while one is out", async () => {
    const gate = new SendGate();
    let release: () => void = () => undefined;
    const first = gate.run(() => new Promise<string>((resolve) => (release = () => resolve("done"))));
    expect(await gate.run(async () => "second")).toEqual({ ok: false });
    release();
    expect(await first).toEqual({ ok: true, value: "done" });
  });
});
