import { describe, expect, it } from "vitest";

import { ATTENTION_REASONS } from "./herald";
import { choiceAllows, effectiveChoice, inputsFrom, NO_CHOICE, ownChoiceOf, type ThreadChoice } from "./thread-choice";

describe("ownChoiceOf", () => {
  it("reads Herald's key, and nothing it does not recognise", () => {
    expect(ownChoiceOf({ announce: "silent" })).toBe("silent");
    expect(ownChoiceOf({ announce: "questions", other: 1 })).toBe("questions");
    expect(ownChoiceOf({ announce: "loud" })).toBeNull();
    expect(ownChoiceOf({})).toBeNull();
    expect(ownChoiceOf(null)).toBeNull();
  });
});

describe("choiceAllows", () => {
  it("lets Announce say everything, Questions only what waits on the user, and Silent nothing", () => {
    const allowed = (choice: ThreadChoice) => ATTENTION_REASONS.filter((reason) => choiceAllows(choice, reason));
    expect(allowed("announce")).toEqual(["question", "plan", "permission", "finished", "error"]);
    expect(allowed("questions")).toEqual(["question", "plan", "permission"]);
    expect(allowed("silent")).toEqual([]);
  });
});

describe("inputsFrom", () => {
  const own = new Map<string, ThreadChoice>([
    ["root", "silent"],
    ["mid", "questions"],
    ["leaf", "announce"],
  ]);

  it("inherits from the nearest thread above with a choice, and says whether it is the parent", () => {
    expect(inputsFrom("child", ["mid", "root"], own)).toEqual({
      own: null,
      inherited: { choice: "questions", threadId: "mid", fromParent: true },
    });
    expect(inputsFrom("child", ["plain", "root"], own)).toEqual({
      own: null,
      inherited: { choice: "silent", threadId: "root", fromParent: false },
    });
  });

  it("keeps the thread's own choice beside what it would inherit", () => {
    expect(inputsFrom("leaf", ["root"], own)).toEqual({
      own: "announce",
      inherited: { choice: "silent", threadId: "root", fromParent: true },
    });
  });

  it("has nothing for a root thread with no choice", () => {
    expect(inputsFrom("alone", [], own)).toEqual(NO_CHOICE);
  });
});

describe("effectiveChoice", () => {
  const silentParent = { own: null, inherited: { choice: "silent" as const, threadId: "p", fromParent: true } };

  it("announces as today when nothing is chosen anywhere", () => {
    expect(effectiveChoice(NO_CHOICE, false, false)).toEqual({ choice: "announce", source: "default" });
  });

  it("keeps a child thread quiet without a choice of its own, as Herald's subagent setting says", () => {
    expect(effectiveChoice(NO_CHOICE, true, false)).toEqual({ choice: "silent", source: "subagent" });
    expect(effectiveChoice(NO_CHOICE, true, true)).toEqual({ choice: "announce", source: "default" });
  });

  it("makes a worker follow its coordinator when subagents are announced", () => {
    expect(effectiveChoice(silentParent, true, true)).toEqual({ choice: "silent", source: "parent" });
    const grandparent = { own: null, inherited: { choice: "questions" as const, threadId: "g", fromParent: false } };
    expect(effectiveChoice(grandparent, true, true)).toEqual({ choice: "questions", source: "ancestor" });
  });

  it("lets a thread's own choice win over its coordinator's and over the subagent setting", () => {
    expect(effectiveChoice({ ...silentParent, own: "announce" }, true, false)).toEqual({ choice: "announce", source: "self" });
    expect(effectiveChoice({ own: "silent", inherited: null }, false, false)).toEqual({ choice: "silent", source: "self" });
  });
});
