import { describe, expect, it } from "vitest";

import { buildAnswers, parsePending, readAloud, type SpokenQuestion } from "./questions";
import { commandApproval, providerQuestion } from "./testing/fakes";

/** A question from bb's Ask User Question plugin, as bb 0.50 lists it (a plugin form). */
function pluginQuestion(threadId: string) {
  return {
    id: "int_p1",
    threadId,
    status: "pending",
    origin: { kind: "plugin", pluginId: "ask-user-question", rendererId: "ask-user-question" },
    payload: {
      kind: "plugin",
      title: "Approach",
      data: {
        questions: [
          {
            id: "q0",
            prompt: "Which approach?",
            shortLabel: "Approach",
            multiSelect: true,
            allowFreeText: true,
            options: [
              { value: "q0o0", label: "Rewrite it", description: "Start over" },
              { value: "q0o1", label: "Patch it", description: "Smallest change" },
              { value: "q0o2", label: "Leave it", description: "Do nothing" },
            ],
          },
        ],
      },
    },
  };
}

describe("parsePending", () => {
  it("reads a provider's question with its options", () => {
    const pending = parsePending(providerQuestion("thr_a"));
    expect(pending).toMatchObject({ kind: "question", via: "provider", interactionId: "int_q1", threadId: "thr_a" });
    if (pending?.kind !== "question") throw new Error("not a question");
    expect(pending.questions[0]?.options.map((option) => [option.n, option.label, option.value])).toEqual([
      [1, "Postgres (Recommended)", "q0o0"],
      [2, "SQLite", "q0o1"],
    ]);
  });

  it("reads bb's Ask User Question plugin form as a question, answered through respond", () => {
    expect(parsePending(pluginQuestion("thr_a"))).toMatchObject({ kind: "question", via: "plugin", interactionId: "int_p1" });
  });

  it("reads another plugin's form by its title only", () => {
    const form = { ...pluginQuestion("thr_a"), origin: { kind: "plugin", pluginId: "other", rendererId: "x" } };
    expect(parsePending(form)).toEqual({ kind: "other", interactionId: "int_p1", threadId: "thr_a", title: "Approach" });
  });

  it("reads an approval with the decisions it offers, in bb's order", () => {
    expect(parsePending(commandApproval("thr_a", "int_a1", ["deny", "allow_once"]))).toEqual({
      kind: "approval",
      interactionId: "int_a1",
      threadId: "thr_a",
      what: "run a command",
      detail: "npm test",
      reason: "To run the tests",
      decisions: ["allow_once", "deny"],
    });
  });

  it("reads a plan approval with the plan's opening", () => {
    const plan = { ...commandApproval("thr_a"), payload: { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject: { kind: "plan", plan: "1. Do it.\n2. Ship it.", planFilePath: null, itemId: "i" } } };
    expect(parsePending(plan)).toMatchObject({ kind: "approval", what: "go ahead with its plan", detail: "1. Do it. 2. Ship it." });
  });

  it("skips an interaction that is no longer pending, and anything unreadable", () => {
    expect(parsePending({ ...providerQuestion("thr_a"), status: "resolved" })).toBeNull();
    expect(parsePending({ nonsense: true })).toBeNull();
  });
});

describe("readAloud", () => {
  it("numbers the options and says how to answer", () => {
    const pending = parsePending(providerQuestion("thr_a"));
    if (pending === null) throw new Error("none");
    expect(readAloud(pending, '"Fix it"')).toBe(
      "Which database should it use? Options: 1. Postgres (Recommended) (The one already in use); 2. SQLite. Pick one. Or answer in your own words.",
    );
  });

  it("says what an approval asks and the choices it offers", () => {
    const pending = parsePending(commandApproval("thr_a"));
    if (pending === null) throw new Error("none");
    expect(readAloud(pending, '"Fix it"')).toBe(
      '"Fix it" asks to run a command: npm test. Its reason: To run the tests. You can approve it this once, or approve it for the rest of the session, or deny it.',
    );
  });
});

describe("buildAnswers", () => {
  const single = (parsePending(providerQuestion("thr_a")) as { questions: SpokenQuestion[] }).questions;
  const multi = (parsePending(pluginQuestion("thr_a")) as { questions: SpokenQuestion[] }).questions;

  it("takes an option by its number or its label, without the (Recommended)", () => {
    expect(buildAnswers(single, [{ options: [2] }], null)).toEqual({ ok: true, answers: { q0: { selected: ["q0o1"] } }, said: "SQLite" });
    expect(buildAnswers(single, [{ options: ["postgres"] }], null)).toMatchObject({ answers: { q0: { selected: ["q0o0"] } } });
    expect(buildAnswers(single, [{ options: ["2"] }], null)).toMatchObject({ answers: { q0: { selected: ["q0o1"] } } });
  });

  it("refuses an option the question does not have", () => {
    expect(buildAnswers(single, [{ options: ["MySQL"] }], null)).toMatchObject({ ok: false });
    expect(buildAnswers(single, [{ options: [3] }], null)).toMatchObject({ ok: false });
  });

  it("refuses two options for a single choice, and takes them for a multiple one", () => {
    expect(buildAnswers(single, [{ options: [1, 2] }], null)).toMatchObject({ ok: false });
    expect(buildAnswers(multi, [{ options: [1, "patch it"] }], null)).toEqual({ ok: true, answers: { q0: { selected: ["q0o0", "q0o1"] } }, said: "Rewrite it and Patch it" });
  });

  it("answers in the user's own words only from the transcript, never the model's", () => {
    expect(buildAnswers(single, [{ useSpokenWords: true }], "Use whatever the staging box has.")).toEqual({
      ok: true,
      answers: { q0: { selected: [], freeText: "Use whatever the staging box has." } },
      said: '"Use whatever the staging box has."',
    });
    expect(buildAnswers(single, [{ useSpokenWords: true }], null)).toMatchObject({ ok: false });
  });

  it("refuses own words where the question takes only its options", () => {
    const strict = single.map((question) => ({ ...question, allowFreeText: false }));
    expect(buildAnswers(strict, [{ useSpokenWords: true }], "anything")).toMatchObject({ ok: false });
  });

  it("needs every required question answered, and an answer for each pick", () => {
    const two = [...single, { ...single[0], id: "q1", prompt: "And the cache?" } as SpokenQuestion];
    expect(buildAnswers(two, [{ question: 1, options: [1] }], null)).toMatchObject({ ok: false, error: expect.stringContaining("And the cache?") });
    expect(buildAnswers(two, [{ question: 1, options: [1] }, { question: 2, options: [2] }], null)).toMatchObject({ ok: true, said: "1: Postgres (Recommended); 2: SQLite" });
    expect(buildAnswers(single, [{}], null)).toMatchObject({ ok: false });
    expect(buildAnswers(two, [{ options: [1] }], null)).toMatchObject({ ok: false });
  });
});
