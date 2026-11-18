import { describe, expect, it } from "vitest";

import { VOICE_TALK_MAX_CHARS } from "../shared/crew-voice";
import { MAX_SEND_CHARS, RateLimit, SendGate, UtteranceLog, VOICE_LINE_MAX_CHARS } from "./policy";
import { FakeClock } from "./testing/fakes";

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

  it("starts after a boundary, and after the segments a send used", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "what's running?");
    await clock.advance(1_000);
    log.boundary(clock.now()); // a reply to it, heard to the end
    await clock.advance(1_000);
    log.transcribed("b", "rebase the login fix");
    expect((await log.sinceBoundary(clock.now()))?.text).toBe("rebase the login fix");
    await clock.advance(1_000);
    log.markUsed((await log.sinceBoundary(clock.now()))?.items ?? []); // sent
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

describe("the talk beside the words", () => {
  it("interleaves what the voice said aloud with the captain's segments, in order, from the boundary", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "what's running?");
    await clock.advance(1_000);
    log.boundary(clock.now()); // the reply below, heard to the end
    log.voiceSaid("r1", clock.now(), "Two workers:\n the login fix and the icons.", false);
    await clock.advance(2_000);
    log.transcribed("b", "Have the icons wait.");
    await clock.advance(1_000);
    log.voiceSaid("r2", clock.now(), "For the login fix?", false);
    log.voiceTalkedOver("r2");
    await clock.advance(500);
    log.transcribed("c", "Yes, that one.");
    const asked = clock.now();
    log.voiceSaid("r3", asked, "Asking the first mate.", false); // the send's own preamble
    const words = await log.sinceBoundary(asked);
    expect(words?.text).toBe("Have the icons wait. Yes, that one.");
    expect(words?.talk).toEqual([
      { who: "voice", text: "Two workers: the login fix and the icons." },
      { who: "captain", text: "Have the icons wait." },
      { who: "voice", text: "For the login fix?", talkedOver: true },
      { who: "captain", text: "Yes, that one." },
    ]);
  });

  it("marks a line talked over before its transcript landed", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.voiceTalkedOver("r1");
    log.voiceSaid("r1", clock.now(), "Captain, the", false);
    await clock.advance(500);
    log.transcribed("a", "Stop the icons.");
    expect((await log.sinceBoundary(clock.now()))?.talk[0]).toEqual({ who: "voice", text: "Captain, the", talkedOver: true });
  });

  it("leads with the first mate's reply the voice read out since the last send, when a later reply set the boundary", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.transcribed("a", "How are the PRs?");
    await clock.advance(500);
    const firstAsk = clock.now();
    log.markUsed((await log.sinceBoundary(firstAsk))?.items ?? [], firstAsk);
    await clock.advance(30_000);
    log.voiceSaid("r1", clock.now(), "The first mate answered you: the voice PR is ready to merge.", true);
    await clock.advance(3_000);
    log.transcribed("b", "Thanks.");
    await clock.advance(500);
    log.boundary(clock.now());
    log.voiceSaid("r2", clock.now(), "Anytime.", false);
    await clock.advance(2_000);
    log.transcribed("c", "Hold it for now.");
    const words = await log.sinceBoundary(clock.now());
    expect(words?.text).toBe("Hold it for now.");
    expect(words?.talk).toEqual([
      { who: "reply", text: "The first mate answered you: the voice PR is ready to merge." },
      { who: "voice", text: "Anytime." },
      { who: "captain", text: "Hold it for now." },
    ]);
  });

  it("never sends a voice line twice, nor a reading from before the last send", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    log.voiceSaid("r1", clock.now(), "The first mate answered you: all green.", true);
    await clock.advance(1_000);
    log.transcribed("a", "Merge the docs fix.");
    const asked = clock.now();
    const first = await log.sinceBoundary(asked);
    expect(first?.talk.map((line) => line.who)).toEqual(["reply", "captain"]);
    log.markUsed(first?.items ?? [], asked);
    await clock.advance(1_000);
    log.transcribed("b", "And the icons.");
    expect((await log.sinceBoundary(clock.now()))?.talk).toEqual([{ who: "captain", text: "And the icons." }]);
  });

  it("cuts a long voice line and drops the oldest voice lines to keep within firstmate-crew's limit", async () => {
    const clock = new FakeClock();
    const log = new UtteranceLog(clock);
    for (let i = 0; i < 12; i += 1) {
      log.voiceSaid(`r${i}`, clock.now(), `${i} ${"x".repeat(2 * VOICE_LINE_MAX_CHARS)}`, false);
      await clock.advance(1_000);
    }
    log.transcribed("a", "y".repeat(MAX_SEND_CHARS));
    const talk = (await log.sinceBoundary(clock.now()))?.talk ?? [];
    expect(talk.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(VOICE_TALK_MAX_CHARS);
    expect(talk.map((line) => line.text.split(" ")[0])).toEqual(["8", "9", "10", "11", "y".repeat(MAX_SEND_CHARS)]);
    expect(talk.filter((line) => line.who === "voice").every((line) => line.text.length === VOICE_LINE_MAX_CHARS)).toBe(true);
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
