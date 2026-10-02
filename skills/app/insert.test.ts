import { describe, expect, it } from "vitest";

import { chatText, withCommand, writesToThread } from "./insert";

describe("chatText", () => {
  it("is the command and a trailing space", () => {
    expect(chatText("diff-check")).toBe("/diff-check ");
    expect(chatText("toolkit:outline")).toBe("/toolkit:outline ");
  });
});

describe("withCommand", () => {
  it("fills an empty or blank draft with the command", () => {
    expect(withCommand("", "/diff-check ")).toBe("/diff-check ");
    expect(withCommand("  \n", "/diff-check ")).toBe("/diff-check ");
  });

  it("puts the command first and keeps what was typed after it", () => {
    expect(withCommand("  look at auth.ts\nplease", "/diff-check ")).toBe("/diff-check look at auth.ts\nplease");
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
