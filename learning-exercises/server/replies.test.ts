/**
 * The agent's messages between questions (a real session, thread thr_f6iewpgi7a): its feedback on question
 * 1 streamed as a message, then the card for question 2 ended the turn and bb folded the feedback away.
 * The plugin keeps that reply with the question, shows it on the next card and in the history. And a
 * question must stand on its own: question 2 there said "the earlier version … shown above" about code
 * no message held.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { QUESTION_MAX_CHARS } from "../shared/types";
import { LearningApi } from "./api";
import { bbPorts } from "./bb-ports";
import { OfferEngine } from "./offers";
import { questionProblem, unclosedFence } from "./question";
import { SessionService } from "./sessions";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { memoryStore, settingsWith } from "./testing/store";

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
    expect(await sessions.backfillReplies(sessionId)).toBe(true);
    expect(store.unreadReplies(sessionId)).toEqual([]);
    expect(store.exercises(sessionId)[0]?.reply).toBeNull();
    // Question 2 answered, nothing written yet: its window is open, so it stays unread until something is.
    ports.advance(1);
    ports.answer({ action: "answer", answer: "y", confidence: 2 });
    await flush();
    expect(await sessions.backfillReplies(sessionId)).toBe(false);
    expect(store.unreadReplies(sessionId)).toEqual([2]);
    ports.advance(1);
    ports.say(threadId, "Right.");
    expect(await sessions.backfillReplies(sessionId)).toBe(true);
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
});

describe("reading the agent's messages from bb's event log", () => {
  type Row = { seq: number; createdAt: number; data: { item: Record<string, unknown> } };

  /** The fake host's events.list over `rows`, newest first, paged by `beforeSeq` as bb pages it. */
  function host(rows: Row[], fail = false) {
    const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
    const calls: { beforeSeq?: string; limit?: string }[] = [];
    harness.sdk.stub("threads.events.list", (input: { beforeSeq?: string; limit?: string; types: string[]; order: string }) => {
      if (fail) throw new Error("log unavailable");
      calls.push({ beforeSeq: input.beforeSeq, limit: input.limit });
      expect(input).toMatchObject({ types: ["item/completed"], order: "desc" });
      const before = input.beforeSeq === undefined ? Infinity : Number(input.beforeSeq);
      return [...rows]
        .sort((a, b) => b.seq - a.seq)
        .filter((row) => row.seq < before)
        .slice(0, Number(input.limit))
        .map((row) => ({ id: `evt_${row.seq}`, scope: { kind: "turn", turnId: "t" }, threadId: WORK, type: "item/completed", ...row }));
    });
    return { ports: bbPorts(bb, () => {}), calls };
  }

  const message = (seq: number, createdAt: number, text: string): Row => ({ seq, createdAt, data: { item: { type: "agentMessage", id: `m${seq}`, text } } });
  const tool = (seq: number, createdAt: number): Row => ({ seq, createdAt, data: { item: { type: "toolCall", id: `t${seq}`, tool: "learning_feedback" } } });

  it("answers the agent's messages inside the window, oldest first, and skips other items", async () => {
    const { ports } = host([message(1, 100, "waiting"), message(2, 200, FEEDBACK), tool(3, 210), message(4, 220, "  "), message(5, 300, "waiting for 2")]);
    expect(await ports.agentMessages(WORK, 150, 300)).toEqual([FEEDBACK]);
    expect(await ports.agentMessages(WORK, 150, null)).toEqual([FEEDBACK, "waiting for 2"]);
  });

  it("pages back through a long turn until it passes the window's start", async () => {
    const rows: Row[] = [message(1, 1, "before"), message(2, 10, "first")];
    for (let seq = 3; seq < 450; seq += 1) rows.push(tool(seq, 10 + seq));
    rows.push(message(450, 500, "last"));
    const { ports, calls } = host(rows);
    expect(await ports.agentMessages(WORK, 5, null)).toEqual(["first", "last"]);
    expect(calls.map((call) => call.beforeSeq)).toEqual([undefined, "251", "51"]);
  });

  it("says when the log cannot be read, which is not the same as no messages", async () => {
    expect(await host([], true).ports.agentMessages(WORK, 0, null)).toBeNull();
    expect(await host([]).ports.agentMessages(WORK, 0, null)).toEqual([]);
  });
});
