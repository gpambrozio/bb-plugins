import { describe, expect, it } from "vitest";

import type { HistoryItem } from "../shared/herald";
import { PLACEMENT_PAGES_MAX, placeSentences } from "./placement";
import type { TimelineCursor, TimelineMessage, TimelinePort, TimelineTurn } from "./ports";
import { recordingLog } from "./testing/fixtures";

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);

function at(second: number): number {
  return T0 + second * 1000;
}

function message(id: string, second: number, role: TimelineMessage["role"], initiator?: "user" | "agent" | "system"): TimelineMessage {
  return { id, createdAt: at(second), role, initiator: role === "user" ? (initiator ?? "user") : null };
}

/** A "Worked for" row: the turn's work and its folded messages; `end` null while it runs. */
function turn(start: number, end: number | null): TimelineTurn {
  return { startedAt: at(start), completedAt: end === null ? null : at(end) };
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

/**
 * A thread's top-level messages, oldest first, served newest page first as bb
 * does (every turn row on the first page). `running` answers each status read
 * in turn (the last one from then on): before the page, then after it.
 */
function fakeTimeline(
  messages: TimelineMessage[],
  options: { perPage?: number; turns?: TimelineTurn[]; running?: boolean | boolean[]; fail?: boolean } = {},
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
        turns: older === null ? (options.turns ?? []) : [],
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
    // The answer is written before the turn ends; the sentence comes just after.
    const { port } = fakeTimeline([message("u1", 0, "user"), message("a1", 10, "assistant")], { turns: [turn(1, 10.5)] });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placed.sentences).toEqual([{ eventId: "t1:idle:1", reason: "finished", createdAt: sentence("t1:idle:1", 11).createdAt, text: "Sentence for t1:idle:1.", messageId: "a1" }]);
    expect(placed.settled).toEqual(new Map([["t1:idle:1", "a1"]]));
  });

  it("counts the message at the event's own millisecond as the one that led to it", async () => {
    const { port } = fakeTimeline([message("a1", 10, "assistant"), message("u2", 30, "user")]);
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 10)], port, recordingLog()))).toEqual({ "t1:idle:1": "a1" });
  });

  it("puts each turn's sentence on its own answer, not on later turns'", async () => {
    const messages = [message("u1", 0, "user"), message("a1", 10, "assistant"), message("u2", 20, "user"), message("a2", 30, "assistant")];
    const { port } = fakeTimeline(messages, { turns: [turn(1, 10.5), turn(21, 30.5)] });
    const placed = await placeSentences("t1", [sentence("t1:idle:2", 31), sentence("t1:idle:1", 11)], port, recordingLog());
    expect(placesOf(placed)).toEqual({ "t1:idle:2": "a2", "t1:idle:1": "a1" });
  });

  it("puts a question's sentence on the answer before it while the turn runs, for now", async () => {
    const messages = [message("u1", 0, "user"), message("a1", 10, "assistant")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    const placed = await placeSentences("t1", [asked], fakeTimeline(messages, { turns: [turn(1, null)], running: true }).port, recordingLog());
    expect(placesOf(placed)).toEqual({ "t1:interaction:i1": "a1" });
    expect(placed.settled.size).toBe(0);
  });

  it("moves a question's sentence to the turn's final answer once the turn has folded the answer before it", async () => {
    // Ended: a1 is inside "Worked for"; the top level has the prompt, the turn's row and its final answer.
    const messages = [message("u1", 0, "user"), message("a2", 30, "assistant")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    const placed = await placeSentences("t1", [asked], fakeTimeline(messages, { turns: [turn(1, 31)] }).port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:interaction:i1", "a2"]]));
  });

  it("keeps nothing for a question inside a turn bb shows as running, even when it falls back to the prompt", async () => {
    // The turn's row holds its work so far; its final answer is yet to come.
    const messages = [message("u1", 0, "user")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    const placed = await placeSentences("t1", [asked], fakeTimeline(messages, { turns: [turn(1, null)] }).port, recordingLog());
    expect(placesOf(placed)).toEqual({ "t1:interaction:i1": "u1" });
    expect(placed.settled.size).toBe(0);
  });

  it("puts an error with no answer on the prompt it failed on, and keeps it: a prompt never folds", async () => {
    const messages = [message("a0", 5, "assistant"), message("u1", 10, "user")];
    const failed = sentence("t1:failed:1", 12, { reason: "error" });
    const placed = await placeSentences("t1", [failed], fakeTimeline(messages, { turns: [turn(11, 11.5)], running: true }).port, recordingLog());
    expect(placed.settled).toEqual(new Map([["t1:failed:1", "u1"]]));
  });

  it("keeps a place on a message another thread or bb sent into a running turn only once no turn runs", async () => {
    // A child's report steers its still-running parent before the question; bb folds such a message into the turn when it ends.
    for (const initiator of ["system", "agent"] as const) {
      const messages = [message("a1", 10, "assistant"), message("s1", 20, "user", initiator)];
      const asked = sentence("t1:interaction:i1", 22, { reason: "question" });
      const running = await placeSentences("t1", [asked], fakeTimeline(messages, { running: true }).port, recordingLog());
      expect(placesOf(running), initiator).toEqual({ "t1:interaction:i1": "s1" });
      expect(running.settled.size, initiator).toBe(0);
      const idle = await placeSentences("t1", [asked], fakeTimeline(messages).port, recordingLog());
      expect(idle.settled, initiator).toEqual(new Map([["t1:interaction:i1", "s1"]]));
    }
  });

  it("keeps nothing from a page read while a turn ran, even when it has ended by the time bb answers", async () => {
    const messages = [message("u1", 0, "user"), message("a1", 10, "assistant")];
    const asked = sentence("t1:interaction:i1", 12, { reason: "question" });
    // Running as the page was read, idle just after: the page's answer may be one the turn then folds.
    const ended = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [true, false] }).port, recordingLog());
    expect(placesOf(ended)).toEqual({ "t1:interaction:i1": "a1" });
    expect(ended.settled.size).toBe(0);
    // Idle as it was read, running just after: a turn started meanwhile, and its answers can fold.
    const started = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [false, true] }).port, recordingLog());
    expect(started.settled.size).toBe(0);
    const still = await placeSentences("t1", [asked], fakeTimeline(messages, { running: [false, false] }).port, recordingLog());
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
    const messages = Array.from({ length: 10 }, (_, n) => message(`m${n}`, n * 10, n % 2 === 0 ? "user" : "assistant"));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    // At 85 s the newest page (80 s, 90 s) already holds the message before it.
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 85)], port, recordingLog()))).toEqual({ "t1:idle:1": "m8" });
    expect(calls.pages).toBe(1);
    // At 75 s it does not: the message before it is on the next page.
    expect(placesOf(await placeSentences("t1", [sentence("t1:idle:1", 75)], port, recordingLog()))).toEqual({ "t1:idle:1": "m7" });
    expect(calls.pages).toBe(3);
  });

  it(`gives up, once, on a sentence older than ${PLACEMENT_PAGES_MAX} pages back`, async () => {
    const messages = Array.from({ length: 20 }, (_, n) => message(`m${n}`, 100 + n * 10, n % 2 === 0 ? "user" : "assistant"));
    const { port, calls } = fakeTimeline(messages, { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:9", 295), sentence("t1:idle:1", 5)], port, recordingLog());
    expect(calls.pages).toBe(PLACEMENT_PAGES_MAX);
    expect(placed.settled).toEqual(new Map([["t1:idle:9", "m19"], ["t1:idle:1", null]]));
  });

  it("draws nothing for a sentence older than every message, and looks again next time", async () => {
    const { port } = fakeTimeline([message("u1", 20, "user")], { perPage: 2 });
    const placed = await placeSentences("t1", [sentence("t1:idle:1", 5)], port, recordingLog());
    expect(placed.sentences).toEqual([]);
    expect(placed.settled.size).toBe(0);
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
