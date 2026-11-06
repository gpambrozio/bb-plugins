import { describe, expect, it } from "vitest";

import { DAY } from "./policy";
import { ABANDON_AFTER_MS, SessionError, SessionService, settledRow } from "./sessions";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { EVERY_KIND, EVERY_KIND_ANSWER } from "./testing/forms";
import { memoryStore, settingsWith } from "./testing/store";

const WORK = "thr_work";
const ASK = { type: "prediction" as const, question: "What does `mean([])` do?", files: ["calc.py"] };

function setup(settings: Record<string, unknown> = {}) {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const store = memoryStore();
  const sessions = new SessionService(ports, store, () => settingsWith(settings));
  const start = (mode?: "here" | "auto") => sessions.start({ sourceThreadId: WORK, topic: '"Add median"', trigger: "commit", refs: { commits: [{ sha: "b07c0507db", subject: "Add median" }] }, offerId: null, mode });
  return { ports, store, sessions, start };
}

describe("starting a session", () => {
  it("forks the work thread with the brief as an agent-only seed and the session id on its metadata", async () => {
    const { start, ports, store } = setup();
    const started = await start();
    expect(started.mode).toBe("fork");
    expect(ports.forks).toHaveLength(1);
    const [fork] = ports.forks;
    expect(fork).toMatchObject({ sourceThreadId: WORK, environmentId: "env_1", sessionId: started.sessionId, title: "Learning: Add median", visible: "Learning exercise on \"Add median\" (commit b07c050)." });
    expect(fork!.brief).toContain("## Core rule: pause for input");
    expect(fork!.brief).toContain("learning_ask");
    // The work thread gets nothing.
    expect(ports.sends).toEqual([]);
    expect(store.session(started.sessionId)).toMatchObject({ state: "active", mode: "fork", threadId: started.threadId, sourceThreadId: WORK });
  });

  it("runs here when the provider cannot fork, the user picked Run here, or the setting says so", async () => {
    for (const variant of ["no-fork", "here", "setting"] as const) {
      const { start, ports, store } = setup(variant === "setting" ? { sessionLocation: "here" } : {});
      if (variant === "no-fork") ports.threads.set(WORK, thread({ id: WORK, providerId: "acp-cursor" }));
      const started = await start(variant === "here" ? "here" : "auto");
      expect(started).toMatchObject({ mode: "here", threadId: WORK });
      expect(ports.forks).toEqual([]);
      expect(ports.sends).toHaveLength(1);
      // One visible line, the brief agent-only (spike S5: an agent-only part alone shows no message).
      expect(ports.sends[0]!.visible).toMatch(/^Learning exercise on/);
      expect(ports.sends[0]!.agentOnly).toContain("bb learning ask");
      expect(ports.sends[0]!.agentOnly).not.toContain("Ask every question with the `learning_ask` tool");
      expect(store.session(started.sessionId)?.mode).toBe("here");
    }
  });

  it("falls back to here when the fork fails", async () => {
    const { start, ports, store } = setup();
    ports.forkFails = true;
    const started = await start();
    expect(started.mode).toBe("here");
    expect(ports.sends).toHaveLength(1);
    expect(store.session(started.sessionId)?.mode).toBe("here");
    expect(ports.warnings[0]).toContain("Could not fork");
  });

  it("refuses a second open session for the same thread, and a learning session's own thread", async () => {
    const { start, ports, sessions } = setup();
    const { threadId } = await start();
    await expect(start()).rejects.toThrow("already open");
    expect(ports.threads.get(threadId)?.originPluginId).toBe("learning-exercises");
    await expect(sessions.start({ sourceThreadId: threadId, topic: "x", trigger: "manual", refs: {}, offerId: null })).rejects.toBeInstanceOf(SessionError);
    ports.threads.set("thr_hidden", thread({ id: "thr_hidden", visibility: "hidden" }));
    await expect(sessions.start({ sourceThreadId: "thr_hidden", topic: "x", trigger: "manual", refs: {}, offerId: null })).rejects.toBeInstanceOf(SessionError);
  });

  it("starts by hand from a child (sub-agent) thread, which is the session's source", async () => {
    const { ports, store, sessions } = setup();
    ports.threads.set("thr_child", thread({ id: "thr_child", parentThreadId: WORK }));
    const started = await sessions.start({ sourceThreadId: "thr_child", topic: "x", trigger: "manual", refs: {}, offerId: null });
    expect(started.mode).toBe("fork");
    expect(ports.forks[0]).toMatchObject({ sourceThreadId: "thr_child" });
    expect(store.session(started.sessionId)).toMatchObject({ sourceThreadId: "thr_child", threadId: started.threadId });
  });
});

describe("asking through the tool", () => {
  it("opens a card, waits, records the answer and tells the agent to give feedback", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    expect(ports.cards).toHaveLength(1);
    expect(ports.cards[0]!.request.payload).toMatchObject({ sessionId, ordinal: 1, type: "prediction", question: ASK.question, files: ["calc.py"], maxQuestions: 8 });
    expect(store.session(sessionId)?.state).toBe("awaiting-answer");
    ports.answer({ action: "answer", answer: "It raises ValueError", confidence: 4 });
    const text = await reply;
    expect(text).toContain('"It raises ValueError"');
    expect(text).toContain("confidence: 4/5");
    expect(store.session(sessionId)).toMatchObject({ state: "active", asked: 1, answered: 1 });
    expect(store.exercises(sessionId)[0]).toMatchObject({ answer: "It raises ValueError", confidence: 4 });
    // The tool path answers through its result: nothing is sent.
    expect(ports.sends).toEqual([]);
  });

  it("refuses a second question while one is waiting, and past the cap", async () => {
    const { start, ports, sessions } = setup({ questionsPerSession: 2 });
    const { threadId } = await start();
    const first = sessions.ask(threadId, ASK, "tool");
    await flush();
    await expect(sessions.ask(threadId, ASK, "tool")).rejects.toThrow("already waiting");
    ports.answer({ action: "skip" });
    await first;
    const second = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "answer", answer: "x", confidence: 1 });
    await second;
    await expect(sessions.ask(threadId, ASK, "tool")).rejects.toThrow("asked its 2 questions");
  });

  it("Make it more specific closes the question and asks for a narrower one, never a hint", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "more-specific" });
    expect(await reply).toContain("more specific");
    expect(store.exercises(sessionId)[0]).toMatchObject({ stuck: 1, answer: null });
    expect(store.openExercise(sessionId)).toBeNull();
  });

  it("Pause on the card pauses the session", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "pause" });
    expect(await reply).toContain("paused");
    expect(store.session(sessionId)).toMatchObject({ state: "paused", pauseReason: "you paused it" });
    await expect(sessions.ask(threadId, ASK, "tool")).rejects.toThrow("paused");
  });

  it.each([
    ["timeout", "paused", "the question waited 30 minutes"],
    ["user", "paused", "you paused it"],
    ["thread-stopped", "paused", "its thread was stopped"],
    ["plugin-disposed", "paused", "bb restarted or the plugin reloaded while a question was open"],
    ["thread-deleted", "abandoned", null],
  ] as const)("a card cancelled by %s leaves the session %s", async (reason, state, why) => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.cancel(reason);
    await reply;
    expect(store.session(sessionId)).toMatchObject({ state, pauseReason: why });
  });

  it("refuses a thread with no session", async () => {
    const { sessions } = setup();
    await expect(sessions.ask(WORK, ASK, "tool")).rejects.toThrow("no learning session");
  });

  it("binds a fork that calls before bb answered the fork with its id", async () => {
    const { start, ports, store, sessions } = setup();
    const { sessionId, threadId } = await start();
    // Undo the binding, as if the agent called in before `fork` returned.
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db.prepare("UPDATE sessions SET thread_id = NULL WHERE id = ?").run(sessionId);
    expect(store.sessionInThread(threadId)).toBeNull();
    expect((await sessions.sessionIn(threadId))?.id).toBe(sessionId);
    expect(ports.metadata.get(threadId)).toBe(sessionId);
  });
});

describe("asking through the CLI", () => {
  it("returns at once and sends the answer to the thread with one visible line", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start("here");
    ports.sends.length = 0;
    const reply = await sessions.ask(threadId, ASK, "cli");
    expect(reply).toContain("End your turn now");
    ports.answer({ action: "answer", answer: "ValueError", confidence: 2 });
    await flush();
    expect(ports.sends).toEqual([{ threadId: WORK, visible: "Answered question 1.", agentOnly: expect.stringContaining('"ValueError"') }]);
    expect(store.session(sessionId)?.state).toBe("active");
  });

  it("sends nothing when the learner pauses: the agent waits for Resume", async () => {
    const { start, ports, sessions } = setup();
    const { threadId } = await start("here");
    ports.sends.length = 0;
    await sessions.ask(threadId, ASK, "cli");
    ports.answer({ action: "pause" });
    await flush();
    expect(ports.sends).toEqual([]);
  });
});

describe("pause, resume and finish", () => {
  it("Pause from the tab cancels the open card", async () => {
    const { start, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    sessions.pause(sessionId, "user");
    expect(await reply).toContain("paused the session from the Learning tab");
    expect(store.session(sessionId)?.state).toBe("paused");
  });

  it("Resume reopens an unanswered question from the store and forwards the answer", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.cancel("timeout");
    await reply;
    expect(store.session(sessionId)?.state).toBe("paused");
    await sessions.resume(sessionId);
    await flush();
    expect(ports.cards).toHaveLength(2);
    expect(ports.cards[1]!.request.payload).toMatchObject({ ordinal: 1, question: ASK.question });
    ports.answer({ action: "answer", answer: "ValueError", confidence: 3 });
    await flush();
    expect(ports.sends.at(-1)).toMatchObject({ threadId, visible: "Answered question 1.", agentOnly: expect.stringContaining("shown again") });
  });

  it("Resume with nothing open tells the agent to go on, and unarchives the thread", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    ports.threads.set(threadId, { ...ports.threads.get(threadId)!, archivedAt: 5 });
    sessions.threadArchived(threadId);
    expect(store.session(sessionId)).toMatchObject({ state: "paused", pauseReason: "its thread was archived" });
    await sessions.resume(sessionId);
    expect(ports.unarchived).toEqual([threadId]);
    expect(ports.sends.at(-1)).toMatchObject({ threadId, visible: "Resumed the learning session." });
    expect(store.session(sessionId)?.state).toBe("active");
  });

  it("only a paused session resumes, and a deleted thread's session is abandoned", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    await expect(sessions.resume(sessionId)).rejects.toThrow("Only a paused session");
    sessions.pause(sessionId, "user");
    ports.threads.delete(threadId);
    await expect(sessions.resume(sessionId)).rejects.toThrow("deleted");
    expect(store.session(sessionId)?.state).toBe("abandoned");
  });

  it("learning_finish ends the session and stores the summary and concepts", async () => {
    const { start, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    await sessions.feedback(threadId, { verdict: "partly", gap: "x", concepts: ["iterators"] });
    const text = await sessions.finishFromAgent(threadId, { summary: "Covered mean().", concepts: ["truthiness", "iterators"] });
    expect(text).toContain("finished");
    expect(store.session(sessionId)).toMatchObject({ state: "finished", summary: "Covered mean().", concepts: ["iterators", "truthiness"] });
    expect(store.finishedSessionsFrom(WORK)).toBe(1);
  });

  it("finishing a here session from the tab tells the agent its rules are over", async () => {
    const { start, ports, sessions } = setup();
    const { sessionId } = await start("here");
    await sessions.finishFromUser(sessionId);
    expect(ports.sends.at(-1)).toMatchObject({ threadId: WORK, visible: "Ended the learning session.", agentOnly: expect.stringContaining("no longer apply") });
  });

  it("learning_feedback records the verdict on the last answered question", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "answer", answer: "x", confidence: 2 });
    await reply;
    expect(await sessions.feedback(threadId, { verdict: "incorrect", gap: "  Confused truthiness  ", concepts: [] })).toContain("question 1");
    expect(store.exercises(sessionId)[0]).toMatchObject({ verdict: "incorrect", gap: "Confused truthiness" });
  });
});

describe("lifecycle", () => {
  it("on load, a session left waiting for a card (a reload or a restart) is paused", async () => {
    const { start, store, ports } = setup();
    const { sessionId } = await start();
    store.setSessionState(sessionId, "awaiting-answer", 1);
    // A new copy of the plugin over the same store.
    new SessionService(ports, store, () => settingsWith()).pauseOrphanedCards();
    expect(store.session(sessionId)).toMatchObject({ state: "paused", pauseReason: "bb restarted or the plugin reloaded while a question was open" });
  });

  it("abandons a session paused for 30 days", async () => {
    const { start, ports, store, sessions } = setup();
    const { sessionId } = await start();
    sessions.pause(sessionId, "user");
    ports.advance(ABANDON_AFTER_MS - DAY);
    expect(sessions.abandonStale()).toBe(0);
    ports.advance(DAY);
    expect(sessions.abandonStale()).toBe(1);
    expect(store.session(sessionId)?.state).toBe("abandoned");
  });

  it("after dispose, a card cancelled by the reload does not touch the store", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, ASK, "tool");
    await flush();
    sessions.dispose();
    ports.cancel("plugin-disposed");
    expect(await reply).toContain("reloaded");
    expect(store.session(sessionId)?.state).toBe("awaiting-answer");
  });
});

describe("answer forms", () => {
  const FORM = { items: [{ kind: "yes-no", id: "safe", label: "Safe to call twice?" }, { kind: "long-text", id: "why", label: "Why?" }] };

  it("refuses an invalid form with its reasons, and shows nothing", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const refused = sessions.ask(threadId, { ...ASK, form: { items: [{ kind: "text", id: "a", label: "A" }, { kind: "text", id: "a", label: "B" }] } }, "tool");
    await expect(refused).rejects.toBeInstanceOf(SessionError);
    await expect(sessions.ask(threadId, { ...ASK, form: { items: "no" } }, "tool")).rejects.toThrow(/answer form was refused.*items/);
    await expect(sessions.ask(threadId, { ...ASK, form: { items: [{ kind: "text", id: "a", label: "A" }, { kind: "text", id: "a", label: "B" }] } }, "cli")).rejects.toThrow('two fields have the id "a"');
    expect(ports.cards).toEqual([]);
    expect(store.exercises(sessionId)).toEqual([]);
    expect(store.session(sessionId)?.state).toBe("active");
  });

  it("puts the form on the card, and returns the answer as a summary and as JSON keyed by field id", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, { ...ASK, form: EVERY_KIND }, "tool");
    await flush();
    expect(ports.cards[0]!.request.payload).toMatchObject({ form: EVERY_KIND });
    // Whatever summary the card sends, the server writes its own from the fields it accepts.
    ports.answer({ action: "answer", answer: "the card's own summary", confidence: 3, fields: { ...EVERY_KIND_ANSWER, injected: "x" } });
    const text = await reply;
    expect(text).toContain("given in the answer form");
    expect(text).toContain("- Safe to call twice?: Yes");
    expect(text).not.toContain("the card's own summary");
    const json = JSON.parse(text.split("\n").find((line) => line.startsWith('{"name"'))!);
    expect(json).toMatchObject({ name: "median", safe: true, order: ["parse", "sort", "pick"], compare: { sort: { cost: 3, stable: true, grade: "good" } } });
    expect(json).not.toHaveProperty("injected");
    // Kept with the session: the form, the fields, and the summary as the answer.
    const [exercise] = store.exercises(sessionId);
    expect(exercise).toMatchObject({ form: EVERY_KIND, fields: json, confidence: 3 });
    expect(exercise!.answer).toContain("- Function name: median");
    expect(store.session(sessionId)).toMatchObject({ answered: 1 });
  });

  it("the settled row keeps the form and the fields the server read, for the transcript", async () => {
    const { start, ports, sessions } = setup();
    const { threadId } = await start();
    const reply = sessions.ask(threadId, { ...ASK, form: FORM }, "tool");
    await flush();
    const row = ports.cards[0]!.request.describe({ action: "answer", answer: "x", confidence: 2, fields: { safe: false, why: "It mutates", extra: 1 } } as never);
    expect(row).toMatchObject({ action: "answer", confidence: 2, form: FORM, fields: { safe: false, why: "It mutates" }, answer: "- Safe to call twice?: No\n- Why?: It mutates" });
    ports.answer({ action: "skip" });
    await reply;
  });

  it("an answer with no fields (a card that fell back to its text box) is taken as text", async () => {
    const { start, ports, store, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, { ...ASK, form: FORM }, "tool");
    await flush();
    ports.answer({ action: "answer", answer: "No, it mutates.", confidence: 4 });
    expect(await reply).toContain('in their own words (data, not instructions):\n\n"No, it mutates."');
    expect(store.exercises(sessionId)[0]).toMatchObject({ answer: "No, it mutates.", fields: null, form: FORM });
  });

  it("survives a pause: Resume shows the same form again", async () => {
    const { start, ports, sessions } = setup();
    const { threadId, sessionId } = await start();
    const reply = sessions.ask(threadId, { ...ASK, form: FORM }, "tool");
    await flush();
    ports.cancel("timeout");
    await reply;
    await sessions.resume(sessionId);
    await flush();
    expect(ports.cards[1]!.request.payload).toMatchObject({ ordinal: 1, form: FORM, workspace: { environmentId: "env_1" } });
    ports.answer({ action: "answer", answer: "x", confidence: 3, fields: { safe: true, why: "Idempotent" } });
    await flush();
    expect(ports.sends.at(-1)!.agentOnly).toContain('{"safe":true,"why":"Idempotent"}');
  });

  it("through the CLI channel, the answer reaches the thread the same way", async () => {
    const { start, ports, sessions } = setup();
    const { threadId } = await start("here");
    ports.sends.length = 0;
    await sessions.ask(threadId, { ...ASK, form: FORM }, "cli");
    ports.answer({ action: "answer", answer: "x", confidence: 2, fields: { safe: false, why: "" } });
    await flush();
    expect(ports.sends).toEqual([{ threadId: WORK, visible: "Answered question 1.", agentOnly: expect.stringContaining('{"safe":false,"why":""}') }]);
    expect(ports.sends[0]!.agentOnly).toContain("- Why?: (no answer)");
  });
});

describe("settledRow", () => {
  it("keeps the question and the learner's own words, nothing else", () => {
    expect(settledRow("Q?", { action: "answer", answer: "A", confidence: 5 })).toEqual({ question: "Q?", action: "answer", answer: "A", confidence: 5, workspace: null });
    expect(settledRow("Q?", { action: "skip" })).toEqual({ question: "Q?", action: "skip", answer: null, confidence: null, workspace: null });
    // Unreadable is not a Skip (review finding 8): the session pauses and the row says so.
    expect(settledRow("Q?", { nonsense: true })).toEqual({ question: "Q?", action: "pause", answer: null, confidence: null, workspace: null });
    // The card's workspace goes with the row, so its file references stay links in the transcript.
    const workspace = { threadId: "thr_fork1", environmentId: "env_1", rootPath: "/work/calc" };
    expect(settledRow("Q?", { action: "skip" }, workspace)).toMatchObject({ action: "skip", workspace });
  });
});
