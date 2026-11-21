import { describe, expect, it } from "vitest";

import { flaggedStatusLine, lastLine, userMessages, userText } from "./messages";

const typed = (text: string) => ({ initiator: "user", systemMessageKind: "unlabeled", input: [{ type: "text", text }] });

describe("userText", () => {
  it("takes what the user typed", () => {
    expect(userText(typed("Fix the login page"))).toBe("Fix the login page");
  });

  it("joins the text parts and skips attachments", () => {
    expect(userText({ initiator: "user", input: [{ type: "text", text: "a" }, { type: "image", url: "x" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("leaves out bb's notices about sub-threads", () => {
    expect(userText({ ...typed("[bb system]\n\n@thread:thr_x completed"), initiator: "system", systemMessageKind: "child-completed" })).toBeNull();
    expect(userText({ ...typed("done"), systemMessageKind: "child-needs-attention" })).toBeNull();
  });

  it("leaves out messages from other threads", () => {
    expect(userText({ ...typed("[bb message from thread:thr_x]\n\nhi"), initiator: "agent" })).toBeNull();
  });

  it("leaves out a plugin's note that carries an agent-only part (firstmate-crew's watch notes)", () => {
    expect(
      userText({
        initiator: "user",
        systemMessageKind: "unlabeled",
        input: [
          { type: "text", text: "Watch note from pr-watch" },
          { type: "text", text: "<firstmate-watch>…", visibility: "agent-only" },
        ],
      }),
    ).toBeNull();
  });

  it("leaves out relayed and bb-prefixed text even when marked as the user's", () => {
    expect(userText(typed("Relayed by bb firstmate-crew tell, from thread thr_x:\n\nhello"))).toBeNull();
    expect(userText(typed("[bb system] something"))).toBeNull();
  });

  it("is null for data it cannot read", () => {
    expect(userText(null)).toBeNull();
    expect(userText({ initiator: "user", input: "nope" })).toBeNull();
    expect(userText(typed("   "))).toBeNull();
  });
});

describe("userMessages", () => {
  it("keeps the order and the sequence numbers", () => {
    const events = [
      { seq: 1, data: typed("first") },
      { seq: 2, data: { initiator: "system", systemMessageKind: "child-completed", input: [] } },
      { seq: 3, data: typed("second") },
    ];
    expect(userMessages(events)).toEqual([
      { seq: 1, text: "first" },
      { seq: 3, text: "second" },
    ]);
  });
});

describe("flaggedStatusLine", () => {
  it("reads a blocked, needs-decision or failed status line from the last line", () => {
    expect(flaggedStatusLine("Did things.\n\nblocked: tests need a DATABASE_URL\n")).toEqual({ state: "blocked", detail: "tests need a DATABASE_URL" });
    expect(flaggedStatusLine("needs-decision: keep the old API or remove it?")).toEqual({ state: "needs a decision", detail: "keep the old API or remove it?" });
    expect(flaggedStatusLine("**failed**: build broke")).toEqual({ state: "failed", detail: "build broke" });
  });

  it("ignores other states and status words that are not on the last line", () => {
    expect(flaggedStatusLine("done: PR https://x")).toBeNull();
    expect(flaggedStatusLine("blocked: earlier\nworking: now fine")).toBeNull();
    expect(flaggedStatusLine(null)).toBeNull();
  });

  it("lastLine is the last non-empty line", () => {
    expect(lastLine("a\nb\n\n  ")).toBe("b");
    expect(lastLine("")).toBeNull();
  });
});
