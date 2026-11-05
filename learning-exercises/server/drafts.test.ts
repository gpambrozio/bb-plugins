/**
 * Unsent answers, kept with their question on the server: read against the question's form like a
 * submitted answer, cleared when the question is answered or skipped, kept through a pause, Resume and
 * a reload.
 */
import { describe, expect, it } from "vitest";

import { draftValues, initialValues } from "../shared/answer-form";
import { SessionService } from "./sessions";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { EVERY_KIND } from "./testing/forms";
import { memoryStoreWithDb, settingsWith } from "./testing/store";

const WORK = "thr_work";

async function setup(form?: unknown) {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const { store, db } = memoryStoreWithDb();
  const sessions = new SessionService(ports, store, () => settingsWith());
  const { threadId, sessionId } = await sessions.start({ sourceThreadId: WORK, topic: "t", trigger: "manual", refs: {}, offerId: null });
  /** Asks question 1 and waits until its card is open; the agent's read is left pending. */
  const ask = async (withForm = form) => {
    void sessions.ask(threadId, { type: "prediction", question: "Q?", files: [], form: withForm }, "tool");
    await flush();
  };
  return { ports, store, db, sessions, threadId, sessionId, ask };
}

describe("saving a draft", () => {
  it("keeps a partly filled form, read against the form as a submitted answer is: what does not fit is dropped", async () => {
    const { sessions, sessionId, ask } = await setup(EVERY_KIND);
    await ask();
    sessions.saveDraft(sessionId, 1, {
      fields: {
        name: "median",
        risk: 150,
        outcome: "explodes",
        callers: ["tests", "nobody"],
        order: ["pick", "nope"],
        pairs: { empty: "error", one: "not-a-match", extra: "x" },
        edges: ["", "one item", 7],
        compare: { heap: { stable: true, cost: "cheap" }, nowhere: { stable: true } },
        unknown: "dropped",
      },
      confidence: 2,
    });
    const draft = sessions.cardDraft(sessionId, 1)!;
    expect(draft.confidence).toBe(2);
    expect(draft.fields).toEqual({
      ...initialValues(EVERY_KIND),
      name: "median",
      // Clamped to the slider's range; an option the form does not have is no answer.
      risk: 100,
      outcome: null,
      callers: ["tests"],
      // The known items, in the order given, then the rest.
      order: ["pick", "parse", "sort"],
      pairs: { empty: "error", one: null },
      edges: ["one item"],
      // One box decided decides the table's boxes; a number cell with text is no answer.
      compare: { sort: { cost: null, stable: false, grade: null }, heap: { cost: null, stable: true, grade: null } },
      // Untouched fields come back as the fresh card has them.
      why: "",
      fix: "",
    });
    expect(draft.fields).not.toHaveProperty("unknown");
  });

  it("re-reads a stored draft against the form when handing it back, so a value that no longer fits is dropped", async () => {
    const { sessions, sessionId, ask, db } = await setup(EVERY_KIND);
    await ask();
    db.prepare(`UPDATE exercises SET draft = ? WHERE session_id = ? AND ordinal = 1`).run(JSON.stringify({ fields: { name: 42, count: 99, module: "calc" }, confidence: 4 }), sessionId);
    expect(sessions.cardDraft(sessionId, 1)).toEqual({ fields: { ...initialValues(EVERY_KIND), name: "", count: 10, module: "calc" }, confidence: 4 });
    db.prepare(`UPDATE exercises SET draft = ? WHERE session_id = ? AND ordinal = 1`).run(JSON.stringify({ confidence: 9 }), sessionId);
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
    db.prepare(`UPDATE exercises SET draft = 'not json' WHERE session_id = ? AND ordinal = 1`).run(sessionId);
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
  });

  it("a question without a form keeps only the text and the confidence, cut at the answer's limit", async () => {
    const { sessions, sessionId, ask } = await setup();
    await ask();
    sessions.saveDraft(sessionId, 1, { answer: "It raises", fields: { name: "x" }, confidence: null });
    expect(sessions.cardDraft(sessionId, 1)).toEqual({ answer: "It raises", confidence: null });
    sessions.saveDraft(sessionId, 1, { answer: "y".repeat(20_000) });
    expect(sessions.cardDraft(sessionId, 1)?.answer).toHaveLength(20_000);
  });

  it("a list left with no entries comes back with the one empty entry a fresh card shows", () => {
    expect(draftValues(EVERY_KIND, { edges: ["", "  "] }).edges).toEqual([""]);
    expect(draftValues(EVERY_KIND, { edges: "not a list" }).edges).toEqual([""]);
  });
});

describe("a draft's life", () => {
  it.each([
    ["an answer", { action: "answer", answer: "x", confidence: 3 }],
    ["a skip", { action: "skip" }],
    ["more specific", { action: "more-specific" }],
  ])("is cleared by %s, and a save that lands afterwards is ignored", async (_label, value) => {
    const { ports, sessions, sessionId, ask } = await setup();
    await ask();
    sessions.saveDraft(sessionId, 1, { answer: "half" });
    ports.answer(value);
    await flush();
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
    sessions.saveDraft(sessionId, 1, { answer: "late" });
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
  });

  it("is kept by a pause, and the question reopened by Resume gets it back, after a reload too", async () => {
    const { ports, store, sessions, sessionId, ask } = await setup(EVERY_KIND);
    await ask();
    sessions.saveDraft(sessionId, 1, { fields: { name: "median" }, confidence: 3 });
    ports.answer({ action: "pause" });
    await flush();
    expect(sessions.cardDraft(sessionId, 1)?.fields?.name).toBe("median");

    // A reload: a new copy of the plugin over the same store.
    sessions.dispose();
    const next = new SessionService(ports, store, () => settingsWith());
    await next.resume(sessionId);
    await flush();
    expect(ports.cards.at(-1)!.request.payload.ordinal).toBe(1);
    expect(next.cardDraft(sessionId, 1)).toMatchObject({ fields: { name: "median" }, confidence: 3 });
  });

  it("is not saved for a question that does not exist, or once the session is over", async () => {
    const { sessions, sessionId, ask } = await setup();
    await ask();
    sessions.saveDraft(sessionId, 2, { answer: "x" });
    expect(sessions.cardDraft(sessionId, 2)).toBeNull();
    sessions.saveDraft("ses_nope", 1, { answer: "x" });
    expect(sessions.cardDraft("ses_nope", 1)).toBeNull();
    await sessions.finishFromUser(sessionId);
    sessions.saveDraft(sessionId, 1, { answer: "after" });
    expect(sessions.cardDraft(sessionId, 1)).toBeNull();
  });
});
