import { describe, expect, it } from "vitest";

import type { HistoryItem } from "../shared/herald";
import { PLACEMENT_PAGES_MAX, placeSentences } from "./placement";
import type { TimelineCursor, TimelineMark, TimelineMessage, TimelinePort } from "./ports";
import { recordingLog } from "./testing/fixtures";

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

function at(second: number): number {
  return T0 + second * 1000;
}

/** A delivered prompt by the person, starting or steering `turnId`. */
function prompt(id: string, second: number, turnId: string | null, initiator: "user" | "agent" | "system" = "user"): TimelineMessage {
  return { id, createdAt: at(second), role: "user", initiator, turnId, undelivered: false };
}

/** A prompt bb holds until the running turn ends: no turn yet. */
function queued(id: string, second: number): TimelineMessage {
  return { id, createdAt: at(second), role: "user", initiator: "user", turnId: null, undelivered: true };
}

function answer(id: string, second: number, turnId: string): TimelineMessage {
  return { id, createdAt: at(second), role: "assistant", initiator: null, turnId, undelivered: false };
}

/** A turn's work or system row, at the top level while the turn runs. */
function work(second: number, turnId: string): TimelineMark {
  return { turnId, startedAt: at(second), folded: false };
}

/** A finished turn's "Worked for" row, which folds its work and intermediate answers. */
function workedFor(second: number, turnId: string): TimelineMark {
  return { turnId, startedAt: at(second), folded: true };
}

function sentence(eventId: string, second: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    eventId,
    reason: "finished",
    createdAt: new Date(at(second)).toISOString(),
    headline: "Finished",
    text: `Sentence for ${eventId}.`,
    ...overrides,
  };
}

function question(eventId: string, second: number): HistoryItem {
  return sentence(eventId, second, { reason: "question", headline: "Which DB?" });
}

/**
 * A thread's top-level rows as bb 0.48.1's timeline projects them, messages
 * oldest first and served newest page first (every other row on the first
 * page). `running` answers each status read in turn (the last one from then
 * on): before the page, then after it.
 */
function fakeTimeline(
  messages: TimelineMessage[],
  options: { perPage?: number; marks?: TimelineMark[]; running?: boolean | boolean[]; fail?: boolean } = {},
) {
  const perPage = options.perPage ?? 100;
  const calls = { pages: 0, running: 0, signals: [] as Array<AbortSignal | undefined> };
  const port: TimelinePort = {
    async page(_threadId, older: TimelineCursor | null, signal) {
      calls.pages += 1;
      calls.signals.push(signal);
      if (options.fail === true) throw new Error("bb is down");
      const end = older === null ? messages.length : older.anchorSeq;
      const start = Math.max(0, end - perPage);
      return {
        messages: messages.slice(start, end),
        marks: older === null ? (options.marks ?? []) : [],
        older: start === 0 ? null : { anchorId: `cursor-${start}`, anchorSeq: start },
      };
    },
    async running() {
      calls.running += 1;
      const answers = Array.isArray(options.running) ? options.running : [options.running ?? false];
      return answers[Math.min(calls.running, answers.length) - 1] ?? false;
    },
  };
  return { port, calls };
}

function placesOf(placement: { sentences: Array<{ eventId: string; messageId: string }> }): Record<string, string> {
  return Object.fromEntries(placement.sentences.map((entry) => [entry.eventId, entry.messageId]));
}

describe("placeSentences", () => {
  it("puts a finished turn's sentence on the turn's final answer, at once, and keeps that place", async () => {
    // The answer is written just before the turn ends; the sentence just after.
    const { port } = fakeTimeline([prompt("u1", 0, "t1"), answer("a1", 10, "t1")], { marks: [workedFor(1, "t1")] });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placed.sentences).toEqual([{ eventId: "t1:idle:1", reason: "finished", createdAt: sentence("t1:idle:1", 11).createdAt, text: "Sentence for t1:idle:1.", messageId: "a1" }]);
    expect(placed.settled).toEqual(new Map([["t1:idle:1", "a1"]]));
  });

  it("counts a row at the event's own millisecond as one that led to it", async () => {
    const { port } = fakeTimeline([prompt("u1", 0, "t1"), answer("a1", 10, "t1"), prompt("u2", 30, "t2")]);
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 10)], port, recordingLog()))).toEqual({ "t1:idle:1": "a1" });
  });

  it("puts each turn's sentence on its own answer, not on later turns'", async () => {
    const messages = [prompt("u1", 0, "t1"), answer("a1", 10, "t1"), prompt("u2", 20, "t2"), answer("a2", 30, "t2")];
    const { port } = fakeTimeline(messages, { marks: [workedFor(1, "t1"), workedFor(21, "t2")] });
    const placed = await placeSentences("t1", [sentence("t1:idle:2", 31), sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placesOf(placed)).toEqual({ "t1:idle:2": "a2", "t1:idle:1": "a1" });
    expect(placed.settled.size).toBe(2);
  });

  it("keeps an early question on its prompt only for now while the turn runs, and moves it to the final answer once it ends", async () => {
    // Running, bb's projection is flat: the prompt and the turn's work so far, no "Worked for" row.
    const asked = question("t1:interaction:i1", 5);
    const active = fakeTimeline([prompt("u1", 0, "t1")], { marks: [work(2, "t1"), work(4, "t1")], running: true });
    const during = await placeSentences("t1", [asked], active.port, recordingLog());
    expect(placesOf(during)).toEqual({ "t1:interaction:i1": "u1" });
    expect(during.settled.size).toBe(0);
    // Answered and ended: the work is folded and the final answer leads.
    const ended = fakeTimeline([prompt("u1", 0, "t1"), answer("a9", 40, "t1")], { marks: [workedFor(1, "t1")] });
    const after = await placeSentences("t1", [asked], ended.port, recordingLog());
    expect(after.settled).toEqual(new Map([["t1:interaction:i1", "a9"]]));
  });

  it("puts a question on the answer before it while the turn runs, for now, and on the final answer once that one is folded", async () => {
    const asked = question("t1:interaction:i1", 12);
    const active = fakeTimeline([prompt("u1", 0, "t1"), answer("a1", 10, "t1")], { marks: [work(11, "t1")], running: true });
    const during = await placeSentences("t1", [asked], active.port, recordingLog());
    expect(placesOf(during)).toEqual({ "t1:interaction:i1": "a1" });
    expect(during.settled.size).toBe(0);
    const ended = fakeTimeline([prompt("u1", 0, "t1"), answer("a2", 30, "t1")], { marks: [workedFor(1, "t1")] });
    expect((await placeSentences("t1", [asked], ended.port, recordingLog())).settled).toEqual(new Map([["t1:interaction:i1", "a2"]]));
  });

  it("never gives the running turn's question to a prompt the person queued for the next one", async () => {
    // The person queued the next task while the turn worked; then the turn asked for permission.
    const asked = sentence("t1:interaction:i1", 20, { reason: "permission", headline: "npm test" });
    const messages = [prompt("u1", 0, "t1"), answer("a1", 10, "t1"), queued("q2", 15)];
    const placed = await placeSentences("t1", [asked], fakeTimeline(messages, { marks: [work(18, "t1")], running: true }).port, recordingLog());
    expect(placesOf(placed)).toEqual({ "t1:interaction:i1": "a1" });
    // Delivered as the next turn, it still is not this turn's message.
    const next = [prompt("u1", 0, "t1"), prompt("u2", 15, "t2"), answer("a3", 40, "t1"), answer("a4", 60, "t2")];
    const later = await placeSentences("t1", [asked], fakeTimeline(next, { marks: [workedFor(1, "t1"), work(45, "t2")], running: true }).port, recordingLog());
    expect(later.settled).toEqual(new Map([["t1:interaction:i1", "a3"]]));
  });

  it("keeps a sentence from a turn that failed with no answer on that turn's prompt, never a later turn's", async () => {
    // Asked, then failed with no prose; a retry was sent before Herald first read the timeline.
    const asked = question("t1:interaction:i1", 5);
    const failed = sentence("t1:failed:1", 8, { reason: "error", headline: "Rate limited" });
    const messages = [prompt("u1", 0, "t1"), prompt("u2", 20, "t2"), answer("a2", 30, "t2")];
    const marks = [workedFor(1, "t1"), work(7, "t1"), workedFor(21, "t2")];
    const placed = await placeSentences("t1", [failed, asked], fakeTimeline(messages, { marks }).port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:failed:1", "u1"], ["t1:interaction:i1", "u1"]]));
  });

  it("puts a sentence of a thread's first turn, whose prompt has no turn id, on that prompt", async () => {
    const asked = question("t1:interaction:i1", 5);
    const placed = await placeSentences("t1", [asked], fakeTimeline([prompt("u1", 0, null)], { marks: [work(2, "t1")] }).port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:interaction:i1", "u1"]]));
  });

  it("keeps a failed first turn's cards on its thread-scoped prompt, never on a task queued during it and accepted as the next turn", async () => {
    // The first prompt has no turn id; turn 1 did only tool work, asked, then failed. The second task,
    // queued meanwhile, kept its queue time and was accepted as turn 2 before Herald first read.
    const asked = sentence("t1:interaction:i1", 5, { reason: "permission", headline: "npm test" });
    const failed = sentence("t1:failed:1", 8, { reason: "error", headline: "Rate limited" });
    const messages = [prompt("u1", 0, null), prompt("u2", 3, "t2")];
    const marks = [work(1, "t1"), work(4, "t1"), work(7, "t1"), work(9, "t2")];
    const placed = await placeSentences("t1", [failed, asked], fakeTimeline(messages, { marks, running: true }).port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:failed:1", "u1"], ["t1:interaction:i1", "u1"]]));
    // With no thread-scoped prompt to stand in, the cards stay unplaced rather than take turn 2's.
    const without = await placeSentences("t1", [failed], fakeTimeline([prompt("u2", 3, "t2")], { marks, running: true }).port, recordingLog());
    expect(without.sentences).toEqual([]);
    expect(without.settled.size).toBe(0);
  });

  it("keeps a place on a message another thread or bb sent into a running turn only once the turn is over", async () => {
    // A child's report steers its still-running parent before the question; bb folds such a message when the turn ends.
    for (const initiator of ["system", "agent"] as const) {
      const messages = [prompt("u1", 0, "t1"), answer("a1", 10, "t1"), prompt("s1", 20, "t1", initiator)];
      const asked = question("t1:interaction:i1", 22);
      const running = await placeSentences("t1", [asked], fakeTimeline(messages, { marks: [work(21, "t1")], running: true }).port, recordingLog());
      expect(placesOf(running), initiator).toEqual({ "t1:interaction:i1": "s1" });
      expect(running.settled.size, initiator).toBe(0);
    }
  });

  it("keeps nothing from a page read while the turn ran, even when it has ended by the time bb answers", async () => {
    const messages = [prompt("u1", 0, "t1"), answer("a1", 10, "t1")];
    const marks = [work(11, "t1")];
    const asked = question("t1:interaction:i1", 12);
    // Running as the page was read, idle just after: the page's answer may be one the turn then folds.
    const ended = await placeSentences("t1", [asked], fakeTimeline(messages, { marks, running: [true, false] }).port, recordingLog());
    expect(placesOf(ended)).toEqual({ "t1:interaction:i1": "a1" });
    expect(ended.settled.size).toBe(0);
    // Idle as it was read, running just after: a turn started meanwhile.
    const started = await placeSentences("t1", [asked], fakeTimeline(messages, { marks, running: [false, true] }).port, recordingLog());
    expect(started.settled.size).toBe(0);
    const still = await placeSentences("t1", [asked], fakeTimeline(messages, { marks, running: [false, false] }).port, recordingLog());
    expect(still.settled).toEqual(new Map([["t1:interaction:i1", "a1"]]));
  });

  it("reads nothing when every place is already kept, and draws the kept ones", async () => {
    const { port, calls } = fakeTimeline([]);
    const placed = await placeSentences(
      "t1",
      [sentence("t1:idle:2", 50, { messageId: "a3" }), sentence("t1:idle:1", 11, { messageId: null })],
      port,
      recordingLog(),
    );
    expect(calls.pages).toBe(0);
    expect(calls.running).toBe(0);
    expect(placesOf(placed)).toEqual({ "t1:idle:2": "a3" });
  });

  it("reads back only as far as a message at or before the oldest sentence to place", async () => {
    const messages = Array.from({ length: 10 }, (_, n) => (n % 2 === 0 ? prompt(`m${n}`, n * 10, `t${n}`) : answer(`m${n}`, n * 10, `t${n - 1}`)));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    // At 95 s the newest page (80 s, 90 s) already holds the turn's answer before it.
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 95)], port, recordingLog()))).toEqual({ "t1:idle:1": "m9" });
    expect(calls.pages).toBe(1);
    // At 75 s it does not: the answer before it is on the next page.
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 75)], port, recordingLog()))).toEqual({ "t1:idle:1": "m7" });
    expect(calls.pages).toBe(3);
  });

  it(`gives up, once, on a sentence older than ${PLACEMENT_PAGES_MAX} pages back`, async () => {
    const messages = Array.from({ length: 20 }, (_, n) => (n % 2 === 0 ? prompt(`m${n}`, 100 + n * 10, `t${n}`) : answer(`m${n}`, 100 + n * 10, `t${n - 1}`)));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:9", 295), sentence("t1:idle:1", 5)], port, recordingLog());
    expect(calls.pages).toBe(PLACEMENT_PAGES_MAX);
    expect(placed.settled).toEqual(new Map([["t1:idle:9", "m19"], ["t1:idle:1", null]]));
  });

  it("draws nothing for a sentence older than every message, and looks again next time", async () => {
    const { port } = fakeTimeline([prompt("u1", 20, "t1")], { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 5)], port, recordingLog());
    expect(placed.sentences).toEqual([]);
    expect(placed.settled.size).toBe(0);
  });

  it("gives up on a sentence whose time cannot be read, without reading the timeline", async () => {
    const { port, calls } = fakeTimeline([prompt("u1", 20, "t1")]);
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 0, { createdAt: "not a time" })], port, recordingLog());
    expect(calls.pages).toBe(0);
    expect(placed.settled).toEqual(new Map([["t1:idle:1", null]]));
  });

  it("draws what it kept and lets the rest wait when bb cannot be read", async () => {
    const { port } = fakeTimeline([], { fail: true });
    const log = recordingLog();
    const placed = await placeSentences("t1", [sentence("t1:idle:2", 50), sentence("t1:idle:1", 11, { messageId: "a1" })], port, log);
    expect(placesOf(placed)).toEqual({ "t1:idle:1": "a1" });
    expect(placed.settled.size).toBe(0);
    expect(log.lines.some((line) => line.startsWith("warn:") && line.includes("bb is down"))).toBe(true);
  });

  it("passes the caller's signal to bb, and says nothing when the caller went", async () => {
    const { port, calls } = fakeTimeline([], { fail: true });
    const controller = new AbortController();
    controller.abort();
    const log = recordingLog();
    await placeSentences("t1", [sentence("t1:idle:1", 11)], port, log, controller.signal);
    expect(calls.signals).toEqual([controller.signal]);
    expect(log.lines).toEqual([]);
  });
});
