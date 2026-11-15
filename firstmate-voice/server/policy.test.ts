import { describe, expect, it } from "vitest";

import { MAX_SEND_CHARS, RateLimit, SendGate, UtteranceLog } from "./policy";
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
