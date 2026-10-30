import { describe, expect, it } from "vitest";

import type { HistoryItem } from "../shared/herald";
import { PLACEMENT_PAGES_MAX, placeSentences } from "./placement";
import type { TimelineCursor, TimelineMessage, TimelinePort } from "./ports";
import { recordingLog } from "./testing/fixtures";

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

function message(id: string, second: number, role: TimelineMessage["role"], initiator?: "user" | "agent" | "system"): TimelineMessage {
  return { id, createdAt: T0 + second * 1000, role, initiator: role === "user" ? (initiator ?? "user") : null };
}

function sentence(eventId: string, second: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    eventId,
    reason: "finished",
    createdAt: new Date(T0 + second * 1000).toISOString(),
    headline: "Finished",
    text: `Sentence for ${eventId}.`,
    ...overrides,
  };
}

/** A thread's top-level messages, oldest first, served newest page first as bb does. */
/** `running` answers each status read in turn (the last one from then on): before the page, then after it. */
function fakeTimeline(messages: TimelineMessage[], options: { perPage?: number; running?: boolean | boolean[]; fail?: boolean } = {}) {
  const perPage = options.perPage ?? 100;
  const calls = { pages: 0, running: 0, signals: [] as Array<AbortSignal | undefined> };
  const port: TimelinePort = {
    async page(_threadId, older: TimelineCursor | null, signal) {
      calls.pages += 1;
      calls.signals.push(signal);
      if (options.fail === true) throw new Error("bb is down");
      const end = older === null ? messages.length : older.anchorSeq;
      const start = Math.max(0, end - perPage);
      return { messages: messages.slice(start, end), older: start === 0 ? null : { anchorId: `cursor-${start}`, anchorSeq: start } };
    },
    async running() {
      calls.running += 1;
      const answers = Array.isArray(options.running) ? options.running : [options.running ?? false];
      return answers[Math.min(calls.running, answers.length) - 1] ?? false;
    },
  };
  return { port, calls };
}

describe("placeSentences", () => {
  it("puts a finished turn's sentence above the next prompt, and keeps that place, even while the prompt's turn runs", async () => {
    const { port } = fakeTimeline([message("u1", 0, "user"), message("a1", 10, "assistant"), message("u2", 30, "user"), message("a2", 40, "assistant")], { running: true });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placed.sentences).toEqual([{ eventId: "t1:idle:1", reason: "finished", createdAt: sentence("t1:idle:1", 11).createdAt, text: "Sentence for t1:idle:1.", messageId: "u2" }]);
    expect(placed.settled).toEqual(new Map([["t1:idle:1", "u2"]]));
    expect(placed.waitingSince).toBeNull();
  });

  it("leaves the newest sentence waiting while nothing comes after it", async () => {
    const { port } = fakeTimeline([message("u1", 0, "user"), message("a1", 10, "assistant")]);
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placed.sentences).toEqual([]);
    expect(placed.settled.size).toBe(0);
    expect(placed.waitingSince).toBe(T0 + 11_000);
  });

  it("does not count the message at the event's own millisecond: that one led to it", async () => {
    const { port } = fakeTimeline([message("a1", 10, "assistant"), message("u2", 30, "user")]);
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 10)], port, recordingLog());
    expect(placed.sentences.map((entry) => entry.messageId)).toEqual(["u2"]);
  });

  it("settles a place above an answer only once no turn runs, since a running turn's messages fold when it ends", async () => {
    const messages = [message("u1", 0, "user"), message("a1", 10, "assistant"), message("a2", 20, "assistant")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    const running = fakeTimeline(messages, { running: true });
    const now = await placeSentences("t1", [asked], running.port, recordingLog());
    expect(now.sentences.map((entry) => entry.messageId)).toEqual(["a2"]);
    expect(now.settled.size).toBe(0);
    expect(now.waitingSince).toBe(T0 + 12_000);
    const idle = fakeTimeline(messages, { running: false });
    const later = await placeSentences("t1", [asked], idle.port, recordingLog());
    expect(later.settled).toEqual(new Map([["t1:interaction:i1", "a2"]]));
    expect(later.waitingSince).toBeNull();
  });

  it("keeps a place above a message another thread or bb sent into a running turn only once no turn runs", async () => {
    // A child's report steers its still-running parent after the question; bb folds such a message into the turn when it ends.
    for (const initiator of ["system", "agent"] as const) {
      const messages = [message("a1", 10, "assistant"), message("s1", 20, "user", initiator), message("a2", 30, "assistant")];
      const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
      const running = await placeSentences("t1", [asked], fakeTimeline(messages, { running: true }).port, recordingLog());
      expect(running.sentences.map((entry) => entry.messageId), initiator).toEqual(["s1"]);
      expect(running.settled.size, initiator).toBe(0);
      // Ended: the report is folded away and the answer leads; a later read places the sentence there for good.
      const folded = [message("a1", 10, "assistant"), message("a2", 30, "assistant")];
      const idle = await placeSentences("t1", [asked], fakeTimeline(folded).port, recordingLog());
      expect(idle.settled, initiator).toEqual(new Map([["t1:interaction:i1", "a2"]]));
    }
  });

  it("keeps nothing from a page read while a turn ran, even when it has ended by the time bb answers", async () => {
    const messages = [message("a1", 10, "assistant"), message("a2", 20, "assistant")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    // Running as the page was read, idle just after: the page's answer may be one the turn then folds.
    const ended = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [true, false] }).port, recordingLog());
    expect(ended.sentences.map((entry) => entry.messageId)).toEqual(["a2"]);
    expect(ended.settled.size).toBe(0);
    // Idle as it was read, running just after: a turn started meanwhile, and its answers can fold.
    const started = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [false, true] }).port, recordingLog());
    expect(started.settled.size).toBe(0);
    const still = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [false, false] }).port, recordingLog());
    expect(still.settled).toEqual(new Map([["t1:interaction:i1", "a2"]]));
  });

  it("reads nothing when every place is already kept, and draws the kept ones", async () => {
    const { port, calls } = fakeTimeline([]);
    const placed = await placeSentences(
      "t1",
      [sentence("t1:idle:2", 50, { messageId: "u3" }), sentence("t1:idle:1", 11, { messageId: null })],
      port,
      recordingLog(),
    );
    expect(calls.pages).toBe(0);
    expect(placed.sentences.map((entry) => entry.messageId)).toEqual(["u3"]);
    expect(placed.waitingSince).toBeNull();
  });

  it("reads back only as far as the oldest sentence to place", async () => {
    const messages = Array.from({ length: 10 }, (_, n) => message(`m${n}`, n * 10, n % 2 === 0 ? "user" : "assistant"));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    // At 85 s the newest page (80 s, 90 s) already reaches back past it.
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 85)], port, recordingLog());
    expect(placed.sentences.map((entry) => entry.messageId)).toEqual(["m9"]);
    expect(calls.pages).toBe(1);
    // At 75 s it does not: a message between 75 s and 80 s would be on the next page.
    const earlier = await placeSentences("t1", [sentence("t1:idle:1", 75)], port, recordingLog());
    expect(earlier.sentences.map((entry) => entry.messageId)).toEqual(["m8"]);
    expect(calls.pages).toBe(3);
  });

  it(`gives up, once, on a sentence older than ${PLACEMENT_PAGES_MAX} pages back`, async () => {
    const messages = Array.from({ length: 20 }, (_, n) => message(`m${n}`, 100 + n * 10, n % 2 === 0 ? "user" : "assistant"));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:9", 285), sentence("t1:idle:1", 5)], port, recordingLog());
    expect(calls.pages).toBe(PLACEMENT_PAGES_MAX);
    expect(placed.settled).toEqual(new Map([["t1:idle:9", "m19"], ["t1:idle:1", null]]));
    expect(placed.waitingSince).toBeNull();
  });

  it("places a sentence from before the first message read when bb has nothing older", async () => {
    const { port } = fakeTimeline([message("u1", 20, "user")], { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 5)], port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:idle:1", "u1"]]));
  });

  it("gives up on a sentence whose time cannot be read, without reading the timeline", async () => {
    const { port, calls } = fakeTimeline([message("u1", 20, "user")]);
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 0, { createdAt: "not a time" })], port, recordingLog());
    expect(calls.pages).toBe(0);
    expect(placed.settled).toEqual(new Map([["t1:idle:1", null]]));
  });

  it("draws what it kept and lets the rest wait when bb cannot be read", async () => {
    const { port } = fakeTimeline([], { fail: true });
    const log = recordingLog();
    const placed = await placeSentences("t1", [sentence("t1:idle:2", 50), sentence("t1:idle:1", 11, { messageId: "u2" })], port, log);
    expect(placed.sentences.map((entry) => entry.messageId)).toEqual(["u2"]);
    expect(placed.settled.size).toBe(0);
    expect(placed.waitingSince).toBe(T0 + 50_000);
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
