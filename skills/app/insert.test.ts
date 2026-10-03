import { describe, expect, it } from "vitest";

import { chatText, withCommand, writesToThread } from "./insert";

describe("chatText", () => {
  it("is the command and a trailing space", () => {
    expect(chatText("diff-check")).toBe("/diff-check ");
    expect(chatText("toolkit:outline")).toBe("/toolkit:outline ");
  });
});

describe("withCommand", () => {
  const draft = (text: string, mentions: { from: number; to: number; label: string }[] = []) => ({ text, mentions });

  it("fills an empty or blank draft with the command", () => {
    expect(withCommand(draft(""), "/diff-check ")).toEqual(draft("/diff-check "));
    expect(withCommand(draft("  \n"), "/diff-check ")).toEqual(draft("/diff-check "));
  });

  it("puts the command first and keeps what was typed after it", () => {
    expect(withCommand(draft("  look at auth.ts\nplease"), "/diff-check ")).toEqual(
      draft("/diff-check look at auth.ts\nplease"),
    );
  });

  it("moves each mention with the text it sits in", () => {
    const before = draft("  see @auth.ts and @api.ts", [
      { from: 6, to: 14, label: "auth.ts" },
      { from: 19, to: 26, label: "api.ts" },
    ]);
    const after = withCommand(before, "/diff-check ");
    expect(after.text).toBe("/diff-check see @auth.ts and @api.ts");
    expect(after.mentions).toEqual([
      { from: 16, to: 24, label: "auth.ts" },
      { from: 29, to: 36, label: "api.ts" },
    ]);
    for (const mention of after.mentions) {
      expect(after.text.slice(mention.from, mention.to)).toBe(`@${mention.label}`);
    }
  });
});

describe("writesToThread", () => {
  it("accepts the thread's own draft and its queued messages", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_a" }, "thr_a")).toBe(true);
    expect(writesToThread({ kind: "queued-message", threadId: "thr_a" }, "thr_a")).toBe(true);
  });

  it("refuses another thread, a side chat and the new-thread composer", () => {
    expect(writesToThread({ kind: "thread", threadId: "thr_b" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "side-chat" }, "thr_a")).toBe(false);
    expect(writesToThread({ kind: "new-thread" }, "thr_a")).toBe(false);
  });
});
