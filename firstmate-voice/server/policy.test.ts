import { describe, expect, it } from "vitest";

import { PressGuard, RateLimit, SendGate, UtteranceLog, isConfirmation, saidReadBack } from "./policy";
import { FakeClock } from "./testing/fakes";

const READ_BACK = 'Press "Hold" on Fix the flaky login test, web pull request 42?';

describe("isConfirmation", () => {
  it.each(["Yes.", "yeah", "Yep, do it.", "Go ahead", "Confirm.", "Aye.", "Yes please do"])("takes %s as a yes", (text) => {
    expect(isConfirmation(text)).toBe(true);
  });

  it.each(["No.", "Wait.", "Don't.", "Yes— no, stop.", "Not sure.", "Cancel that.", "Hold on, yes", "", "Okay.", "Yes, and then also tell it to run the whole test suite again"])(
    "refuses %s",
    (text) => {
      expect(isConfirmation(text)).toBe(false);
    },
  );
});

describe("saidReadBack", () => {
  it("needs most of the read-back's words", () => {
    expect(saidReadBack('Captain, press "Hold" on Fix the flaky login test, web pull request 42?', READ_BACK)).toBe(true);
    expect(saidReadBack("Shall I press it?", READ_BACK)).toBe(false);
  });
});

describe("UtteranceLog", () => {
  it("gives the latest words committed before a response, waiting for a transcript on its way", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.committed("a");
    log.transcribed("a", "first");
    await clock.advance(1_000);
    log.committed("b");
    const asked = clock.now();
    await clock.advance(1_000);
    log.committed("c"); // said after the response started: not part of this ask
    const pending = log.latest(2, asked);
    log.transcribed("b", "second");
    log.transcribed("c", "third");
    expect((await pending)?.text).toBe("first second");
  });

  it("gives nothing once the words are used or too old", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "hello");
    const found = await log.latest(1, clock.now());
    log.markUsed(found?.items ?? []);
    expect(await log.latest(1, clock.now())).toBeNull();
    log.transcribed("b", "again");
    await clock.advance(4 * 60_000);
    expect(await log.latest(1, clock.now())).toBeNull();
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
