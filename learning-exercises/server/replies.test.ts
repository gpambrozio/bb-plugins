/**
 * The agent's messages between questions (a real session, thread thr_f6iewpgi7a): its feedback on question
 * 1 streamed as a message, then the card for question 2 ended the turn and bb folded the feedback away.
 * The plugin keeps that reply with the question, shows it on the next card and in the history. And a
 * question must stand on its own: question 2 there said "the earlier version … shown above" about code
 * no message held.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { FEEDBACK_MAX_CHARS, QUESTION_MAX_CHARS } from "../shared/types";
import { LearningApi } from "./api";
import { bbPorts } from "./bb-ports";
import { OfferEngine } from "./offers";
import { questionProblem, unclosedFence } from "./question";
import { SessionService } from "./sessions";
import { listEvents, type EventListInput, type LogRow } from "./testing/event-log";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { memoryStore, memoryStoreWithDb, settingsWith } from "./testing/store";

const WORK = "thr_work";
const Q1 = { type: "trace" as const, question: "Trace `crownMoved` with -0.35.", files: [] };
const Q2 = { type: "debug" as const, question: "Here is the spill branch before the fix:\n\n```swift\nif spilled { return }\n```\n\nWhen does the map jump back?", files: [] };
const FEEDBACK = "You got all three right.\n\nWhat your walkthrough leaves out is *why there's no spill*.";

async function setup() {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const store = memoryStore();
  const sessions = new SessionService(ports, store, () => settingsWith());
  const { threadId, sessionId } = await sessions.start({ sourceThreadId: WORK, topic: '"Crown browsing"', trigger: "manual", refs: {}, offerId: null });
  /** Asks through the tool and answers once the card is up, a millisecond later. */
  const askAndAnswer = async (input: typeof Q1, value: unknown) => {
    const pending = sessions.ask(threadId, input, "tool");
    await flush();
    ports.advance(1);
    ports.say(threadId, "I'm waiting for your answer in the card.");
    ports.advance(1);
    ports.answer(value);
    return pending;
  };
  return { ports, store, sessions, threadId, sessionId, askAndAnswer };
}

describe("the agent's reply between questions", () => {
  it("is kept with the question it answers, and the next card shows it above the question", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "Focus ends at 2", confidence: 4 });
    ports.advance(1);
    ports.say(threadId, FEEDBACK);
    ports.advance(1);
    await sessions.feedback(threadId, { verdict: "correct", gap: "Missed the spill check", concepts: [] });
    // Kept as soon as the verdict is recorded, so the history has it even if no question follows.
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);

    ports.advance(1);
    const second = sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards.at(-1)!.request.payload.previous).toEqual({ ordinal: 1, answered: true, reply: FEEDBACK });
    // What the agent writes after asking is not part of the reply to question 1.
    ports.advance(1);
    ports.say(threadId, "I'm waiting for your answer to question 2 in the card.");
    await sessions.finishFromUser(sessionId);
    await second;
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    expect(store.exercises(sessionId)[1]?.reply).toBeNull();
  });

  it("joins several messages in order, and the first card has none", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    expect(ports.cards[0]!.request.payload.previous).toBeUndefined();
    ports.advance(1);
    ports.say(threadId, "Not quite.");
    ports.advance(1);
    ports.say(threadId, "  The loop stops at `oldest`.  ");
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards.at(-1)!.request.payload.previous?.reply).toBe("Not quite.\n\nThe loop stops at `oldest`.");
    expect(store.exercises(sessionId)[0]?.reply).toBe("Not quite.\n\nThe loop stops at `oldest`.");
  });

  it("after a skip, the card says it follows the question, not that it is feedback on an answer", async () => {
    const { ports, sessions, threadId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "skip" });
    ports.advance(1);
    ports.say(threadId, "No problem. The answer was 2.");
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards.at(-1)!.request.payload.previous).toEqual({ ordinal: 1, answered: false, reply: "No problem. The answer was 2." });
  });

  it("a log that cannot be read when asking keeps the reply read with the verdict", async () => {
    const { ports, sessions, threadId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.advance(1);
    ports.say(threadId, FEEDBACK);
    await sessions.feedback(threadId, { verdict: "partly", gap: null, concepts: [] });
    ports.messagesUnreadable = true;
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards.at(-1)!.request.payload.previous?.reply).toBe(FEEDBACK);
  });

  it("after a reload, Resume reopens the question with the feedback above it again", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.advance(1);
    ports.say(threadId, FEEDBACK);
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    // The plugin reloads: bb cancels the open card, the new copy pauses the session.
    sessions.dispose();
    ports.cancel("plugin-disposed");
    await flush();
    const next = new SessionService(ports, store, () => settingsWith());
    next.pauseOrphanedCards();
    ports.messagesUnreadable = true;
    await next.resume(sessionId);
    await flush();
    expect(ports.cards.at(-1)!.request.payload).toMatchObject({ ordinal: 2, question: Q2.question, previous: { ordinal: 1, answered: true, reply: FEEDBACK } });
  });

  it("the last answer's feedback is kept when the agent finishes, and when the learner does", async () => {
    for (const by of ["agent", "learner"] as const) {
      const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
      await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
      ports.advance(1);
      ports.say(threadId, FEEDBACK);
      ports.advance(1);
      if (by === "agent") await sessions.finishFromAgent(threadId, { summary: "Covered the crown.", concepts: [] });
      else await sessions.finishFromUser(sessionId);
      expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    }
  });

  it("cuts a very long reply, and keeps nothing when nothing was written", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    await sessions.feedback(threadId, { verdict: "partly", gap: null, concepts: [] });
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    ports.advance(1);
    ports.say(threadId, "y".repeat(30_000));
    await sessions.feedback(threadId, { verdict: "partly", gap: null, concepts: [] });
    const reply = store.exercises(sessionId)[0]!.reply!;
    expect(reply).toHaveLength(20_000);
    expect(reply.endsWith("…")).toBe(true);
  });
});

describe("feedback passed with the verdict (thr_9fuduh4nry)", () => {
  // There the last answer's feedback was a message in the turn that finished the session, folded into
  // "Worked for": only the closing line stayed in view. The feedback now travels with the verdict, and the
  // chat shows it as a card in the turn that recorded it.
  const LAST = "You named testability, but not why one model keeps the rules in one place.";

  it("is the question's reply, with the turn it was recorded in, over anything the agent wrote as a message", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "Focus ends at 2", confidence: 4 });
    ports.running.set(threadId, "turn_2");
    ports.advance(1);
    ports.say(threadId, "Let me check the code.");
    await expect(sessions.feedback(threadId, { verdict: "correct", feedback: `  ${FEEDBACK}\n`, gap: null, concepts: [] })).resolves.toContain("question 1");
    expect(store.exercises(sessionId)[0]).toMatchObject({ verdict: "correct", reply: FEEDBACK });
    expect(store.feedbackCards(threadId)).toEqual([{ sessionId, ordinal: 1, turnId: "turn_2", verdict: "correct", feedback: FEEDBACK }]);
    // The next card and the history show the same text; asking does not replace it with the log's messages.
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards.at(-1)!.request.payload.previous).toEqual({ ordinal: 1, answered: true, reply: FEEDBACK });
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    expect(store.unreadReplies(sessionId)).toEqual([]);
  });

  it("the last answer's feedback gets its card in the turn that finishes the session", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.running.set(threadId, "turn_8");
    await sessions.feedback(threadId, { verdict: "partly", feedback: LAST, gap: "Missed the single source of truth", concepts: [] });
    ports.advance(1);
    ports.say(threadId, "Thanks for working through these.");
    await sessions.finishFromAgent(threadId, { summary: "Crown maths.", concepts: [] });
    expect(store.feedbackCards(threadId)).toEqual([{ sessionId, ordinal: 1, turnId: "turn_8", verdict: "partly", feedback: LAST }]);
    expect(store.exercises(sessionId)[0]?.reply).toBe(LAST);
  });

  it("an agent that passes no text falls back to its message, read from the log, and its card shows that", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.running.set(threadId, "turn_2");
    ports.advance(1);
    ports.say(threadId, FEEDBACK);
    ports.advance(1);
    await sessions.feedback(threadId, { verdict: "incorrect", gap: null, concepts: [] });
    expect(store.feedbackCards(threadId)).toEqual([{ sessionId, ordinal: 1, turnId: "turn_2", verdict: "incorrect", feedback: FEEDBACK }]);
  });

  it("a later verdict on the same question keeps the text and the turn it does not replace, and an unknown turn draws no card", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    // The log cannot say which turn this is: the feedback is kept for the next card and the history.
    await sessions.feedback(threadId, { verdict: "partly", feedback: LAST, gap: null, concepts: [] });
    expect(store.feedbackCards(threadId)).toEqual([]);
    expect(store.exercises(sessionId)[0]?.reply).toBe(LAST);
    ports.running.set(threadId, "turn_2");
    await sessions.feedback(threadId, { verdict: "incorrect", gap: null, concepts: [] });
    expect(store.feedbackCards(threadId)).toEqual([{ sessionId, ordinal: 1, turnId: "turn_2", verdict: "incorrect", feedback: LAST }]);
    ports.running.set(threadId, "turn_3");
    await sessions.feedback(threadId, { verdict: "correct", feedback: "On reflection, right.", gap: null, concepts: [] });
    expect(store.feedbackCards(threadId)).toEqual([{ sessionId, ordinal: 1, turnId: "turn_3", verdict: "correct", feedback: "On reflection, right." }]);
  });

  it("refuses feedback longer than the card takes, and records nothing", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.running.set(threadId, "turn_2");
    await expect(sessions.feedback(threadId, { verdict: "correct", feedback: "y".repeat(FEEDBACK_MAX_CHARS + 1), gap: null, concepts: [] })).rejects.toThrow(
      "The feedback is 8,001 characters; at most 8,000 are kept.",
    );
    expect(store.exercises(sessionId)[0]).toMatchObject({ verdict: null, reply: null });
    expect(store.feedbackCards(threadId)).toEqual([]);
  });

  it("reads the current turn from bb's log: the newest turn/started row's turn", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
    const rows: Row[] = [
      { seq: 1, createdAt: 1, turnId: "turn_1", type: "turn/started", data: {} },
      { seq: 2, createdAt: 2, turnId: "turn_1", type: "turn/completed", data: { status: "completed" } },
      { seq: 3, createdAt: 3, turnId: "turn_2", type: "turn/started", data: {} },
      message(4, 4, FEEDBACK),
    ];
    let fail = false;
    harness.sdk.stub("threads.events.list", (input: EventListInput) => {
      if (fail) throw new Error("log unavailable");
      return listEvents(rows, input);
    });
    const ports = bbPorts(bb, () => {});
    expect(await ports.currentTurn(WORK)).toBe("turn_2");
    fail = true;
    expect(await ports.currentTurn(WORK)).toBeNull();
    expect(harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toEqual(["Reading thr_work's current turn failed: log unavailable"]);
  });
});

describe("a session already running when the fix is installed (thr_f6iewpgi7a)", () => {
  it("after the reload, the history and the reopened question show the feedback from the thread's log, with no new message", async () => {
    // The real timings: the answer to question 1 resolved at …828874, the feedback (seq 442) completed at
    // …841320, question 2's card opened at …854572 and the agent then wrote "waiting" (seq 470).
    const { ports, store, sessions, threadId, sessionId } = await setup();
    ports.clock = 1793917296637;
    const first = sessions.ask(threadId, Q1, "tool");
    await flush();
    ports.clock = 1793917297514;
    ports.say(threadId, "I'm waiting for your answer to the first question in the card.");
    ports.clock = 1793917828874;
    // The build that ran it kept no reply: the log read nothing for it.
    ports.messagesUnreadable = true;
    ports.answer({ action: "answer", answer: "Focus ends at 2", confidence: 4 });
    await first;
    ports.clock = 1793917841320;
    ports.say(threadId, FEEDBACK);
    ports.clock = 1793917842604;
    await sessions.feedback(threadId, { verdict: "correct", gap: null, concepts: [] });
    ports.clock = 1793917854572;
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    ports.clock = 1793917855600;
    ports.say(threadId, "I'm waiting for your answer to question 2 in the card.");
    expect(store.exercises(sessionId).map((exercise) => exercise.reply)).toEqual([null, null]);

    // Installing the fix reloads the plugin: bb cancels the card, and the new copy pauses the session.
    sessions.dispose();
    ports.cancel("plugin-disposed");
    await flush();
    ports.messagesUnreadable = false;
    ports.clock = 1793918000000;
    const next = new SessionService(ports, store, () => settingsWith());
    next.pauseOrphanedCards();
    const sendsBefore = ports.sends.length;

    // The Learning tab's history reads it from the log.
    const api = new LearningApi({ ports, store, offers: new OfferEngine({ ports, store, settings: () => settingsWith() }), sessions: next, settings: () => settingsWith() });
    const detail = await api.sessionDetail({ sessionId });
    expect(detail.exercises.map((exercise) => exercise.reply)).toEqual([FEEDBACK, null]);

    // Resume reopens question 2 with the feedback above it.
    await next.resume(sessionId);
    await flush();
    expect(ports.cards.at(-1)!.request.payload).toMatchObject({ ordinal: 2, previous: { ordinal: 1, answered: true, reply: FEEDBACK } });
    expect(ports.sends).toHaveLength(sendsBefore);
  });

  it("a question the agent wrote nothing after is read once, and an open window is read again later", async () => {
    const { ports, store, sessions, threadId, sessionId, askAndAnswer } = await setup();
    ports.messagesUnreadable = true;
    await askAndAnswer(Q1, { action: "answer", answer: "x", confidence: 2 });
    ports.advance(1);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    ports.messagesUnreadable = false;
    expect(store.unreadReplies(sessionId)).toEqual([1]);
    expect((await sessions.backfillReplies(sessionId)).kept).toBe(true);
    expect(store.unreadReplies(sessionId)).toEqual([]);
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    // Question 2 answered, nothing written yet: its window is open, so it stays unread until something is.
    ports.advance(1);
    ports.answer({ action: "answer", answer: "y", confidence: 2 });
    await flush();
    expect((await sessions.backfillReplies(sessionId)).kept).toBe(false);
    expect(store.unreadReplies(sessionId)).toEqual([2]);
    ports.advance(1);
    ports.say(threadId, "Right.");
    expect((await sessions.backfillReplies(sessionId)).kept).toBe(true);
    expect(store.exercises(sessionId)[1]?.reply).toBe("Right.");
  });
});

describe("a question stands on its own", () => {
  it("is refused, and nothing shown, when a code block it opens never closes", async () => {
    const { ports, sessions, threadId } = await setup();
    const open = { ...Q2, question: "The earlier version:\n\n```swift\nif spilled { return }\n\nWhen does the map jump back?" };
    await expect(sessions.ask(threadId, open, "tool")).rejects.toThrow("code block opened on line 3 never closes");
    expect(ports.cards).toHaveLength(0);
    await expect(sessions.ask(threadId, open, "cli")).rejects.toThrow("Nothing was shown to the learner");
  });

  it("is refused when it is longer than the card takes, and a question carrying its code is accepted", async () => {
    const { ports, sessions, threadId } = await setup();
    await expect(sessions.ask(threadId, { ...Q1, question: "x".repeat(QUESTION_MAX_CHARS + 1) }, "tool")).rejects.toThrow("at most 8,000");
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(ports.cards[0]!.request.payload.question).toBe(Q2.question);
  });

  it("reads fences as CommonMark does", () => {
    expect(unclosedFence("no code")).toBeNull();
    expect(unclosedFence("```ts\nconst a = 1;\n```")).toBeNull();
    expect(unclosedFence("~~~\ncode\n~~~")).toBeNull();
    // A longer fence holds a shorter one; a closing fence may be longer, never shorter.
    expect(unclosedFence("````md\n```ts\nx\n```\n````")).toBeNull();
    expect(unclosedFence("````\nx\n```")).toBe(1);
    // Backticks and tildes do not close each other; indentation past three spaces is not a fence.
    expect(unclosedFence("```\nx\n~~~")).toBe(1);
    expect(unclosedFence("```\nx\n    ```")).toBe(1);
    // A closing fence takes no info string; inline backticks after a fence make it inline code.
    expect(unclosedFence("```\nx\n``` swift")).toBe(1);
    expect(unclosedFence("```a`b``` is inline")).toBeNull();
    expect(unclosedFence("Text\r\n```\r\ncode\r\n```\r\n")).toBeNull();
    expect(questionProblem("Fine `inline` code.")).toBeNull();
  });

  it("reads fences inside Markdown containers: list items, their indentation, block quotes (review pass 1 of 4ccc177)", () => {
    // A fence right after a list marker, closed at the item's indentation.
    expect(unclosedFence("Read this code:\n\n- ```ts\n  const x = 1;\n  ```\n\nWhat is x?")).toBeNull();
    expect(unclosedFence("1. ```ts\n   const x = 1;\n   ```\n2. Then?")).toBeNull();
    // Opened on its own line in an item, closed four spaces in: past three absolute, within three of the item.
    expect(unclosedFence("1.  Look:\n\n    ```py\n    x = 1\n    ```\n\nWhat is x?")).toBeNull();
    expect(unclosedFence("- Outer\n  - Inner:\n\n    ```\n    code\n     ```\n")).toBeNull();
    // Block quotes, plain and nested in a list.
    expect(unclosedFence("> ```js\n> let a;\n> ```\n\nWhy?")).toBeNull();
    expect(unclosedFence("- > ```\n  > x\n  > ```")).toBeNull();
    // Really unclosed: the block ends with its container.
    expect(unclosedFence("- ```ts\n  const x = 1;\n- What is x?")).toBe(1);
    expect(unclosedFence("> ```js\n> let a;\n\nWhy?")).toBe(1);
    expect(unclosedFence("Intro\n\n1. Fine:\n   ```\n   ok\n   ```\n2. Not:\n   ~~~\n   left open")).toBe(8);
    // A fence-like line in an item's content is content, so it closes nothing.
    expect(unclosedFence("- ```\n  x\n```")).toBe(1);
  });
});

type Row = LogRow;

/** The fake host's events.list over `rows` (read when called, so a test can add rows), newest first, paged by `beforeSeq` as bb pages it. */
function host(rows: Row[], fail: boolean | (() => boolean) = false) {
  const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
  const calls: { beforeSeq?: string; limit?: string }[] = [];
  harness.sdk.stub("threads.events.list", (input: { beforeSeq?: string; limit?: string; types: string[]; order: string }) => {
    if (typeof fail === "function" ? fail() : fail) throw new Error("log unavailable");
    calls.push({ beforeSeq: input.beforeSeq, limit: input.limit });
    expect(input).toMatchObject({ types: ["item/completed"], order: "desc" });
    return listEvents(rows, { ...input, threadId: WORK, order: "desc" });
  });
  return { ports: bbPorts(bb, () => {}), calls, harness };
}

const message = (seq: number, createdAt: number, text: string): Row => ({ seq, createdAt, data: { item: { type: "agentMessage", id: `m${seq}`, text } } });
const tool = (seq: number, createdAt: number): Row => ({ seq, createdAt, data: { item: { type: "toolCall", id: `t${seq}`, tool: "learning_feedback" } } });
const all = (from: number, to: number | null) => ({ from, to, before: null, pages: 10 });

describe("reading the agent's messages from bb's event log", () => {
  it("answers the agent's messages inside the window, oldest first, and skips other items", async () => {
    const { ports } = host([message(1, 100, "waiting"), message(2, 200, FEEDBACK), tool(3, 210), message(4, 220, "  "), message(5, 300, "waiting for 2")]);
    expect(await ports.agentMessages(WORK, all(150, 300))).toEqual({ texts: [FEEDBACK], complete: true, before: null, pages: 1 });
    expect((await ports.agentMessages(WORK, all(150, null)))?.texts).toEqual([FEEDBACK, "waiting for 2"]);
  });

  it("pages back through a long turn until it passes the window's start", async () => {
    const rows: Row[] = [message(1, 1, "before"), message(2, 10, "first")];
    for (let seq = 3; seq < 450; seq += 1) rows.push(tool(seq, 10 + seq));
    rows.push(message(450, 500, "last"));
    const { ports, calls } = host(rows);
    expect(await ports.agentMessages(WORK, all(5, null))).toEqual({ texts: ["first", "last"], complete: true, before: null, pages: 5 });
    expect(calls.map((call) => call.beforeSeq)).toEqual([undefined, "351", "251", "151", "51"]);
    // Never more than bb takes per page.
    expect(calls.every((call) => call.limit === "100")).toBe(true);
  });

  it("out of pages, says the read is incomplete and where to go on, and goes on from there", async () => {
    const rows: Row[] = [message(1, 10, "first")];
    for (let seq = 2; seq <= 450; seq += 1) rows.push(tool(seq, 10 + seq));
    const { ports, calls } = host(rows);
    expect(await ports.agentMessages(WORK, { from: 5, to: null, before: null, pages: 2 })).toEqual({ texts: [], complete: false, before: "251", pages: 2 });
    expect(await ports.agentMessages(WORK, { from: 5, to: null, before: "251", pages: 3 })).toEqual({ texts: ["first"], complete: true, before: null, pages: 3 });
    expect(calls.map((call) => call.beforeSeq)).toEqual([undefined, "351", "251", "151", "51"]);
  });

  it("asks bb for pages it takes: a limit over 100 is refused live (bb 0.48.1), and here", async () => {
    expect(() => listEvents([], { threadId: WORK, order: "desc", limit: "101" })).toThrow("HTTP 400: Thread event limit cannot exceed 100");
    expect(listEvents([], { threadId: WORK, order: "desc", limit: "100" })).toEqual([]);
  });

  it("logs a read that fails as a warning", async () => {
    const { ports, harness } = host([], true);
    expect(await ports.agentMessages(WORK, all(0, null))).toBeNull();
    expect(await ports.turnFileChanges(WORK, "t")).toEqual([]);
    expect(harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message)).toEqual([
      "Reading thr_work's messages failed: log unavailable",
      "Reading the files thr_work's turn changed failed: log unavailable",
    ]);
  });

  it("finds a turn's file changes over pages of 100, and stops once past the turn", async () => {
    const change = (seq: number, turnId: string, path: string): Row => ({ seq, createdAt: seq, turnId, data: { item: { type: "fileChange", changes: [{ kind: "add", path }] } } });
    const rows: Row[] = [];
    for (let seq = 1; seq <= 50; seq += 1) rows.push(seq === 10 ? change(seq, "t1", "old.ts") : { ...tool(seq, seq), turnId: "t1" });
    for (let seq = 51; seq <= 200; seq += 1) rows.push(seq === 60 || seq === 190 ? change(seq, "t2", `new${seq}.ts`) : { ...tool(seq, seq), turnId: "t2" });
    const { ports, calls } = host(rows);
    expect(await ports.turnFileChanges(WORK, "t2")).toEqual([
      { kind: "add", path: "new190.ts" },
      { kind: "add", path: "new60.ts" },
    ]);
    expect(calls).toEqual([
      { beforeSeq: undefined, limit: "100" },
      { beforeSeq: "101", limit: "100" },
    ]);
  });

  it("says when the log cannot be read, which is not the same as no messages", async () => {
    expect(await host([], true).ports.agentMessages(WORK, all(0, null))).toBeNull();
    expect(await host([]).ports.agentMessages(WORK, all(0, null))).toEqual({ texts: [], complete: true, before: null, pages: 1 });
  });
});

describe("a backfill that runs out of pages (review pass 1 of 4ccc177)", () => {
  /** FakePorts whose event log is the real reader over the fake host's `rows`. */
  async function logged() {
    const rows: Row[] = [];
    const log = { broken: false };
    const reader = host(rows, () => log.broken);
    class LogPorts extends FakePorts {
      override agentMessages(threadId: string, window: Parameters<FakePorts["agentMessages"]>[1]) {
        return reader.ports.agentMessages(threadId, window);
      }
    }
    const ports = new LogPorts();
    ports.threads.set(WORK, thread({ id: WORK }));
    const { store, db } = memoryStoreWithDb();
    const sessions = new SessionService(ports, store, () => settingsWith());
    const { threadId, sessionId } = await sessions.start({ sourceThreadId: WORK, topic: "t", trigger: "manual", refs: {}, offerId: null });
    // Question 1 answered at T, question 2 asked at T + 20, the session finished at T + 30, with nothing
    // in the log yet: as a build that kept no replies left it.
    void sessions.ask(threadId, Q1, "tool");
    await flush();
    const answeredAt = ports.clock;
    ports.answer({ action: "answer", answer: "x", confidence: 2 });
    await flush();
    ports.advance(20);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    ports.advance(10);
    await sessions.finishFromUser(sessionId);
    await flush();
    expect(store.unreadReplies(sessionId)).toEqual([1]);
    reader.calls.length = 0;
    return { rows, calls: reader.calls, store, db, sessions, sessionId, answeredAt, ports, log };
  }

  it("an empty partial read is not stored: the answer stays unread, and the next read goes on from the saved place", async () => {
    const { rows, calls, store, sessions, sessionId, answeredAt } = await logged();
    // The feedback, then the agent's "waiting" after question 2, then 2,100 tool calls of later work.
    rows.push(message(1, answeredAt + 10, FEEDBACK), message(2, answeredAt + 21, "waiting"));
    for (let seq = 3; seq <= 2102; seq += 1) rows.push(tool(seq, answeredAt + 40 + seq));

    expect((await sessions.backfillReplies(sessionId)).kept).toBe(false);
    expect(calls).toHaveLength(20);
    expect(store.unreadReplies(sessionId)).toEqual([1]);
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    expect(store.replyProgress(sessionId, 1)).toEqual({ before: "103", text: "", truncated: false });

    expect((await sessions.backfillReplies(sessionId)).kept).toBe(true);
    expect(calls.slice(20).map((call) => call.beforeSeq)).toEqual(["103", "3"]);
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    expect(store.unreadReplies(sessionId)).toEqual([]);
    expect(store.replyProgress(sessionId, 1)).toBeNull();
    // Read for good: nothing is read again.
    expect((await sessions.backfillReplies(sessionId)).kept).toBe(false);
    expect(calls).toHaveLength(22);
  });

  it("a nonempty partial read is not stored as a shortened reply: the parts found are kept until the read completes", async () => {
    const { rows, calls, store, sessions, sessionId, answeredAt } = await logged();
    // The feedback in two messages with 2,100 tool calls between them, all before question 2.
    rows.push(message(1, answeredAt + 1, FEEDBACK));
    for (let seq = 2; seq <= 2101; seq += 1) rows.push(tool(seq, answeredAt + 1 + seq / 1000));
    rows.push(message(2102, answeredAt + 15, "And one more thing."));

    expect((await sessions.backfillReplies(sessionId)).kept).toBe(false);
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    expect(store.unreadReplies(sessionId)).toEqual([1]);
    expect(store.replyProgress(sessionId, 1)).toEqual({ before: "103", text: "And one more thing.", truncated: false });

    expect((await sessions.backfillReplies(sessionId)).kept).toBe(true);
    expect(calls.slice(20).map((call) => call.beforeSeq)).toEqual(["103", "3"]);
    expect(store.exercises(sessionId)[0]?.reply).toBe(`${FEEDBACK}\n\nAnd one more thing.`);
  });

  it("one history open goes on reading in the background, then refreshes the history with the feedback (review pass 2)", async () => {
    const { rows, calls, store, sessions, sessionId, answeredAt, ports } = await logged();
    // The feedback lies past three budgets: 6,100 later tool calls above it.
    rows.push(message(1, answeredAt + 10, FEEDBACK));
    for (let seq = 2; seq <= 6101; seq += 1) rows.push(tool(seq, answeredAt + 40 + seq));
    const api = new LearningApi({ ports, store, offers: new OfferEngine({ ports, store, settings: () => settingsWith() }), sessions, settings: () => settingsWith() });
    const changes = ports.changes;

    // The open: its read stops at the budget and answers no feedback yet.
    expect((await api.sessionDetail({ sessionId })).exercises[0]?.reply).toBeNull();
    const running = sessions.recovering(sessionId);
    expect(running).toBeDefined();
    // A refetch while it runs reads nothing more.
    await api.sessionDetail({ sessionId });
    await running;
    // Three budgets of 20 pages over the later work, then two pages to the feedback; the views are told once.
    expect(calls).toHaveLength(62);
    expect(ports.changes).toBe(changes + 1);
    expect((await api.sessionDetail({ sessionId })).exercises[0]?.reply).toBe(FEEDBACK);
    expect(sessions.recovering(sessionId)).toBeUndefined();
  });

  it("stops going on when the log becomes unreadable", async () => {
    const { rows, calls, store, sessions, sessionId, answeredAt, log } = await logged();
    rows.push(message(1, answeredAt + 10, FEEDBACK));
    for (let seq = 2; seq <= 6101; seq += 1) rows.push(tool(seq, answeredAt + 40 + seq));
    await sessions.recoverReplies(sessionId);
    const running = sessions.recovering(sessionId);
    log.broken = true;
    await running;
    // Stopped at the first unreadable page: the question stays unread with its saved place.
    expect(calls.length).toBeLessThan(40);
    expect(store.unreadReplies(sessionId)).toEqual([1]);
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    expect(store.replyProgress(sessionId, 1)).not.toBeNull();
  });

  it("keeps saved progress within the reply's limit: the oldest-first start, with a mark that it was cut (review pass 2)", async () => {
    const { rows, calls, store, sessions, sessionId, answeredAt, db } = await logged();
    // Three long messages, each in its own budget's reach, all before question 2.
    const [a, b, c] = ["a", "b", "c"].map((letter) => letter.repeat(15_000));
    rows.push(message(1, answeredAt + 1, a!));
    for (let seq = 2; seq <= 2101; seq += 1) rows.push(tool(seq, answeredAt + 1 + seq / 1000));
    rows.push(message(2102, answeredAt + 4, b!));
    for (let seq = 2103; seq <= 4202; seq += 1) rows.push(tool(seq, answeredAt + 4 + (seq - 2102) / 1000));
    rows.push(message(4203, answeredAt + 8, c!));

    await sessions.backfillReplies(sessionId);
    const stored = () => (db.prepare(`SELECT reply_progress AS p FROM exercises WHERE session_id = ? AND ordinal = 1`).get(sessionId) as { p: string | null }).p;
    // After one budget: only c, whole.
    expect(store.replyProgress(sessionId, 1)).toEqual({ before: "2204", text: c, truncated: false });
    await sessions.backfillReplies(sessionId);
    // After two: b then c, cut to 20,000 characters, marked as cut; the stored value stays that size.
    expect(store.replyProgress(sessionId, 1)).toEqual({ before: "204", text: `${b}\n\n${c}`.slice(0, 20_000), truncated: true });
    expect(stored()!.length).toBeLessThan(20_100);
    await sessions.backfillReplies(sessionId);
    const reply = store.exercises(sessionId)[0]!.reply!;
    expect(reply).toBe(`${a}\n\n${b!.slice(0, 20_000 - 15_002 - 1)}…`);
    expect(reply).toHaveLength(20_000);
    expect(stored()).toBeNull();
    expect(calls).toHaveLength(43);
  });

  it("reads an oversized or misshapen saved value as none, and starts again from the newest event", async () => {
    const { store, sessionId, db } = await logged();
    const save = (value: unknown) => db.prepare(`UPDATE exercises SET reply_progress = ? WHERE session_id = ? AND ordinal = 1`).run(JSON.stringify(value), sessionId);
    save({ before: "5", text: "x".repeat(20_001), truncated: true });
    expect(store.replyProgress(sessionId, 1)).toBeNull();
    save({ before: "5", texts: ["old shape"] });
    expect(store.replyProgress(sessionId, 1)).toBeNull();
    save({ before: "5; DROP", text: "", truncated: false });
    expect(store.replyProgress(sessionId, 1)).toBeNull();
  });

  it("a capture that runs out of pages keeps the reply an earlier read kept", async () => {
    const rows: Row[] = [];
    const reader = host(rows);
    class LogPorts extends FakePorts {
      override agentMessages(threadId: string, window: Parameters<FakePorts["agentMessages"]>[1]) {
        return reader.ports.agentMessages(threadId, window);
      }
    }
    const ports = new LogPorts();
    ports.threads.set(WORK, thread({ id: WORK }));
    const store = memoryStore();
    const sessions = new SessionService(ports, store, () => settingsWith());
    const { threadId, sessionId } = await sessions.start({ sourceThreadId: WORK, topic: "t", trigger: "manual", refs: {}, offerId: null });
    void sessions.ask(threadId, Q1, "tool");
    await flush();
    const answeredAt = ports.clock;
    ports.answer({ action: "answer", answer: "x", confidence: 2 });
    await flush();
    rows.push(message(1, answeredAt + 1, FEEDBACK));
    ports.advance(5);
    await sessions.feedback(threadId, { verdict: "partly", gap: null, concepts: [] });
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    // A long stretch of tool calls before the next question: that read cannot reach the answer.
    for (let seq = 2; seq <= 2101; seq += 1) rows.push(tool(seq, answeredAt + 2 + seq / 1000));
    ports.advance(5);
    void sessions.ask(threadId, Q2, "tool");
    await flush();
    expect(store.exercises(sessionId)[0]?.reply).toBe(FEEDBACK);
    expect(ports.cards.at(-1)!.request.payload.previous?.reply).toBe(FEEDBACK);
  });
});
