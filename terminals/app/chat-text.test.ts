/**
 * The text "Add to chat" writes: a fenced block that cannot end early, a
 * header naming the tab and machine, and a draft that keeps what was in it.
 */
import { describe, expect, it } from "vitest";

import { appendToDraft, normalizeSelection, terminalBlock } from "./chat-text";

const source = { tabLabel: "build", hostName: "Mac mini" };

describe("normalizeSelection", () => {
  it("makes line endings \\n, drops xterm's trailing padding and trims blank edge lines", () => {
    expect(normalizeSelection("\r\n\n  $ ls   \r\n  a.txt\t\r\n\n")).toBe("  $ ls\n  a.txt");
  });

  it("keeps blank lines inside the selection", () => {
    expect(normalizeSelection("one\n\n\ntwo")).toBe("one\n\n\ntwo");
  });
});

describe("terminalBlock", () => {
  it("fences the selection under a header naming the tab and its machine", () => {
    expect(terminalBlock("$ npm test\nok", source)).toBe("Terminal output from build on Mac mini:\n\n```text\n$ npm test\nok\n```");
  });

  it("does not name the machine twice when the tab's title is the machine's", () => {
    expect(terminalBlock("ok", { tabLabel: "Mac mini 2", hostName: "Mac mini" })).toBe(
      "Terminal output from Mac mini 2:\n\n```text\nok\n```",
    );
  });

  it("uses a fence longer than any run of backticks in the text", () => {
    const block = terminalBlock("```js\nx\n```\n````", source);
    expect(block).toBe("Terminal output from build on Mac mini:\n\n`````text\n```js\nx\n```\n````\n`````");
  });

  it("fences a long selection with more backtick runs than a function call takes arguments", () => {
    // 75,000 separate runs (a Markdown dump within the terminal's scrollback), and one longer run at the end.
    const text = Array.from({ length: 7_500 }, () => Array(10).fill("`value`").join(" ")).join("\n") + "\n````";
    const block = terminalBlock(text, source);
    expect(block?.startsWith("Terminal output from build on Mac mini:\n\n`````text\n")).toBe(true);
    expect(block?.endsWith("\n`````")).toBe(true);
  });

  it("is null for a selection of whitespace only", () => {
    expect(terminalBlock(" \n\t\n", source)).toBeNull();
  });
});

describe("appendToDraft", () => {
  const block = "Terminal output from build on Mac mini:\n\n```text\nok\n```";

  it("fills an empty draft with the block and a newline to type on", () => {
    expect(appendToDraft({ text: "", mentions: [], attachments: [] }, block)).toEqual({
      text: `${block}\n`,
      mentions: [],
      attachments: [],
    });
  });

  it("adds the block after a blank line, keeping the user's text, mentions and attachments", () => {
    const mention = { from: 0, to: 6, label: "@thing", kind: "project" as const, projectId: "proj_1" };
    const attachment = { type: "localFile" as const, path: "/tmp/a", name: "a", hostId: "mini" };
    const draft = { text: "@thing look at this\n\n", mentions: [mention], attachments: [attachment] };
    expect(appendToDraft(draft, block)).toEqual({
      text: `@thing look at this\n\n${block}\n`,
      mentions: [mention],
      attachments: [attachment],
    });
  });

  it("replaces a draft of whitespace only", () => {
    expect(appendToDraft({ text: "  \n", mentions: [] }, block).text).toBe(`${block}\n`);
  });
});
