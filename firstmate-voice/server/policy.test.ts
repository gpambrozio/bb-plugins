import { describe, expect, it } from "vitest";

import { MAX_SEND_CHARS, PressGuard, RateLimit, SendGate, UtteranceLog, isConfirmation, saidReadBack } from "./policy";
import { FakeClock } from "./testing/fakes";

const READ_BACK = 'Press "Hold" on Fix the flaky login test, web pull request 42?';

describe("isConfirmation", () => {
  it.each(["Yes.", "yeah", "Yep, do it.", "Go ahead", "Confirm.", "Aye.", "Yes please do", "Aye aye, captain.", "Yes, thank you.", "Okay, yes.", "Yes. Yes."])(
    "takes %s as a yes",
    (text) => {
      expect(isConfirmation(text)).toBe(true);
    },
  );

  it.each([
    "No.",
    "Wait.",
    "Don't.",
    "Yes— no, stop.",
    "Not sure.",
    "Cancel that.",
    "Hold on, yes",
    "",
    "Okay.",
    "Yes, and then also tell it to run the whole test suite again",
    "Yes, but use SQLite instead.",
    "Yes, if the checks are green.",
    "Yeah, or the other one.",
    "Sure, after lunch.",
    "Yes for the second one.",
    "Yes, press SQLite.",
  ])("refuses %s", (text) => {
    expect(isConfirmation(text)).toBe(false);
  });
});

describe("saidReadBack", () => {
  it("takes the read-back said whole and in order, with a short lead-in", () => {
    expect(saidReadBack(READ_BACK, READ_BACK)).toBe(true);
    expect(saidReadBack('Captain, press "Hold" on Fix the flaky login test, web pull request 42?', READ_BACK)).toBe(true);
    expect(saidReadBack('Aye, let me check. Shall I press \u201cHold\u201d on Fix the flaky login test, web pull request forty-two, captain?', READ_BACK)).toBe(true);
    expect(saidReadBack("Press Hold on Fix the flaky login test, web pull request number 42?", READ_BACK)).toBe(true);
  });

  it("takes a read-back whose title holds a full stop, said exactly or with the stop dropped", () => {
    const readBack = 'Press "Hold" on Fix parsing. Add regression coverage, web pull request 42?';
    expect(saidReadBack(readBack, readBack)).toBe(true);
    expect(saidReadBack('Captain, press "Hold" on Fix parsing, add regression coverage, web pull request 42?', readBack)).toBe(true);
    const asked = 'Press "Postgres?" on Choose the database?';
    expect(saidReadBack(asked, asked)).toBe(true);
    expect(saidReadBack('Press "SQLite?" on Choose the database?', asked)).toBe(false);
    expect(saidReadBack('I won\'t press "Hold" on Fix parsing. Add regression coverage, web pull request 42.', readBack)).toBe(false);
  });

  it("reads pull request numbers of a hundred and more said in words, and only the right one", () => {
    const r112 = 'Press "Hold" on Fix the flaky login test, web pull request 112?';
    for (const said of ["one hundred twelve", "one hundred and twelve", "a hundred and twelve", "112"]) {
      expect(saidReadBack(`Press "Hold" on Fix the flaky login test, web pull request ${said}?`, r112)).toBe(true);
    }
    for (const said of ["one hundred eleven", "one hundred and thirteen", "one hundred", "two hundred twelve", "1,112"]) {
      expect(saidReadBack(`Press "Hold" on Fix the flaky login test, web pull request ${said}?`, r112)).toBe(false);
    }
    const r1112 = 'Press "Hold" on Fix the flaky login test, web pull request 1112?';
    for (const said of ["one thousand one hundred twelve", "one thousand one hundred and twelve", "1,112", "1112"]) {
      expect(saidReadBack(`Press "Hold" on Fix the flaky login test, web pull request ${said}?`, r1112)).toBe(true);
    }
    for (const said of ["one thousand one hundred eleven", "one thousand twelve", "112"]) {
      expect(saidReadBack(`Press "Hold" on Fix the flaky login test, web pull request ${said}?`, r1112)).toBe(false);
    }
  });

  it("never sums number words that run on past one number", () => {
    const say = (n: string) => `Press "Hold" on Fix the flaky login test, web pull request ${n}?`;
    expect(saidReadBack(say("forty-two"), READ_BACK)).toBe(true);
    expect(saidReadBack(say("forty two"), READ_BACK)).toBe(true);
    for (const n of ["twenty twenty-two", "twenty twenty two", "forty one one", "forty two two", "four two", "twenty two twenty", "forty and two", "two forty"]) {
      expect(saidReadBack(say(n), READ_BACK)).toBe(false);
    }
    const r2022 = 'Press "Hold" on Fix the flaky login test, web pull request 2022?';
    expect(saidReadBack(say("twenty twenty-two"), r2022)).toBe(false); // ambiguous, so refused rather than guessed
    expect(saidReadBack(say("two thousand twenty-two"), r2022)).toBe(true);
    expect(saidReadBack(say("two thousand and twenty-two"), r2022)).toBe(true);
  });

  it("refuses a read-back that names another button, another pull request, or comes negated", () => {
    expect(saidReadBack("Shall I press it?", READ_BACK)).toBe(false);
    const postgres = 'Press "Postgres" on Choose the database for the web project?';
    expect(saidReadBack('Press "SQLite" on Choose the database for the web project?', postgres)).toBe(false);
    expect(saidReadBack('Press "Hold" on Fix the flaky login test, web pull request 43?', READ_BACK)).toBe(false);
    expect(saidReadBack('Press "Hold" on Fix the flaky login test, web pull request 42 or 43?', READ_BACK)).toBe(false);
    expect(saidReadBack('I won\'t press "Hold" on Fix the flaky login test, web pull request 42.', READ_BACK)).toBe(false);
    expect(saidReadBack('Instead, press "Hold" on Fix the flaky login test, web pull request 42?', READ_BACK)).toBe(false);
    expect(saidReadBack('Press "Hold" on the flaky login test, web pull request 42?', READ_BACK)).toBe(false);
    expect(saidReadBack('Hold on Fix the flaky login test, web pull request 42, press?', READ_BACK)).toBe(false);
  });
});

describe("UtteranceLog", () => {
  it("gives every segment since the last boundary committed before a response, waiting for a transcript on its way", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.committed("a");
    log.transcribed("a", "first");
    await clock.advance(1_000);
    log.committed("b");
    const asked = clock.now();
    await clock.advance(1_000);
    log.committed("c"); // said after the response started: not part of this ask
    const pending = log.sinceBoundary(asked);
    log.transcribed("b", "second");
    log.transcribed("c", "third");
    expect((await pending)?.text).toBe("first second");
  });

  it("starts after a boundary, and after the segments a send or a press used", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "what's running?");
    await clock.advance(1_000);
    log.boundary(clock.now()); // a reply to it, heard to the end
    await clock.advance(1_000);
    log.transcribed("b", "rebase the login fix");
    expect((await log.sinceBoundary(clock.now()))?.text).toBe("rebase the login fix");
    await clock.advance(1_000);
    log.transcribed("c", "yes");
    await clock.advance(1_000);
    log.markUsed([...(await log.sinceBoundary(clock.now()))?.items ?? []].slice(-1)); // "yes" confirmed a press
    await clock.advance(1_000);
    log.transcribed("d", "and the dark mode branch");
    expect((await log.sinceBoundary(clock.now()))?.text).toBe("and the dark mode branch");
  });

  it("reserves the segments as a send starts: a boundary while a transcript is on its way does not drop it", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.committed("a");
    const asked = clock.now();
    const pending = log.sinceBoundary(asked);
    await clock.advance(1_000);
    log.boundary(clock.now()); // some reply finished meanwhile
    await clock.advance(400);
    log.transcribed("a", "rebase the icons");
    expect((await pending)?.text).toBe("rebase the icons");
  });

  it("keeps to the send limit, dropping the oldest segments", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    for (const id of ["a", "b", "c"]) {
      log.transcribed(id, id.repeat(MAX_SEND_CHARS / 2 - 10));
      await clock.advance(1_000);
    }
    const found = await log.sinceBoundary(clock.now());
    expect(found?.items.map((item) => item.itemId)).toEqual(["b", "c"]);
    expect(found?.text.length).toBeLessThanOrEqual(MAX_SEND_CHARS);
  });

  it("gives nothing once the words are used or too old", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "hello");
    const found = await log.sinceBoundary(clock.now());
    log.markUsed(found?.items ?? []);
    expect(await log.sinceBoundary(clock.now())).toBeNull();
    await clock.advance(1_000);
    log.transcribed("b", "again");
    await clock.advance(4 * 60_000);
    expect(await log.sinceBoundary(clock.now())).toBeNull();
  });
});

describe("PressGuard", () => {
  function guard() {
    const clock = new FakeClock();
    const utterances = new UtteranceLog(clock);
    return { clock, utterances, guard: new PressGuard(clock, utterances) };
  }

  it("confirms on the captain's yes after the read-back", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke(READ_BACK);
    presses.audioFinished();
    await clock.advance(1_500);
    utterances.committed("u1");
    utterances.transcribed("u1", "Yes.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: true, proposal: { ref: "c1.a2", etag: "etag" } });
  });

  it("refuses a read-back that named another choice, whatever the yes after it", async () => {
    const { clock, utterances, guard: presses } = guard();
    const postgres = 'Press "Postgres" on Choose the database for the web project?';
    const proposal = presses.propose("c2.a1", "etag", postgres);
    presses.spoke('Press "SQLite" on Choose the database for the web project?');
    presses.audioFinished();
    await clock.advance(1_500);
    utterances.transcribed("u1", "Yes.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false, reason: expect.stringContaining("read-back was not spoken") });
  });

  it("refuses a read-back naming another pull request in grouped number words, whatever the yes after it", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke('Press "Hold" on Fix the flaky login test, web pull request twenty twenty-two?');
    presses.audioFinished();
    await clock.advance(1_500);
    utterances.transcribed("u1", "Yes.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false, reason: expect.stringContaining("read-back was not spoken") });
  });

  it("refuses a qualified or corrected yes", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c2.a1", "etag", READ_BACK);
    presses.spoke(READ_BACK);
    presses.audioFinished();
    await clock.advance(1_500);
    utterances.transcribed("u1", "Yes, but use SQLite instead.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false, reason: expect.stringContaining("not a plain yes") });
  });

  it("does not count a read-back the captain talked over", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke(READ_BACK);
    presses.audioCut();
    presses.audioFinished();
    await clock.advance(500);
    utterances.transcribed("u1", "Yes.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false, reason: expect.stringContaining("read-back was not spoken") });
  });

  it("refuses a confirmation without a read-back", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke("Want me to do that?");
    await clock.advance(1_000);
    utterances.transcribed("u1", "Yes.");
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false, reason: expect.stringContaining("read-back was not spoken") });
  });

  it("refuses a yes said before the read-back", async () => {
    const { clock, utterances, guard: presses } = guard();
    const proposal = presses.propose("c1.a2", "etag", READ_BACK);
    utterances.transcribed("u0", "Yes, press hold.");
    await clock.advance(500);
    presses.spoke(READ_BACK);
    presses.audioFinished();
    expect(await presses.confirm(proposal.token)).toMatchObject({ ok: false });
  });

  it("refuses outside the window, a replayed token, a stale token, and presses too close together", async () => {
    const { clock, utterances, guard: presses } = guard();
    const late = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke(READ_BACK);
    presses.audioFinished();
    await clock.advance(31_000);
    utterances.transcribed("u1", "Yes.");
    expect((await presses.confirm(late.token)).ok).toBe(false);

    const first = presses.propose("c1.a2", "etag", READ_BACK);
    const second = presses.propose("s1", "etag", 'Press the suggestion "Review loop on web#42"?');
    expect((await presses.confirm(first.token)).ok).toBe(false);
    presses.spoke('Press the suggestion "Review loop on web#42"?');
    presses.audioFinished();
    await clock.advance(500);
    utterances.transcribed("u2", "Yes.");
    expect((await presses.confirm(second.token)).ok).toBe(true);
    expect((await presses.confirm(second.token)).ok).toBe(false);

    const soon = presses.propose("c1.a2", "etag", READ_BACK);
    presses.spoke(READ_BACK);
    presses.audioFinished();
    await clock.advance(500);
    utterances.transcribed("u3", "Yes.");
    expect(await presses.confirm(soon.token)).toMatchObject({ ok: false, reason: expect.stringContaining("ten seconds") });
  });
});

describe("RateLimit and SendGate", () => {
  it("allows the limit per window", async () => {
    const clock = new FakeClock();
    const limit = new RateLimit(clock, 2, 1_000);
    expect([limit.take(), limit.take(), limit.take()]).toEqual([true, true, false]);
    await clock.advance(1_000);
    expect(limit.take()).toBe(true);
  });

  it("refuses a second send while one is out", async () => {
    const gate = new SendGate();
    let release!: () => void;
    const first = gate.run(() => new Promise<string>((resolve) => (release = () => resolve("one"))));
    expect(await gate.run(async () => "two")).toEqual({ ok: false });
    release();
    expect(await first).toEqual({ ok: true, value: "one" });
  });
});
