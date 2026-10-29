import { describe, expect, it } from "vitest";

import { parseHunks, revertHunks } from "./revert";
import { linesText, parsePatchLines } from "./patch-lines";
import { bodyParts, insertSuggestion, replaceLines, suggestedLines as suggestedLinesOf, suggestionLines, suggestionState } from "./suggestion";

describe("suggested changes", () => {
  it("splits a comment into text and suggestion blocks", () => {
    expect(bodyParts("Use a const:\n```suggestion\nconst b = 3;\n```\nThanks")).toEqual([
      { kind: "text", text: "Use a const:\n" },
      { kind: "suggestion", code: "const b = 3;\n" },
      { kind: "text", text: "\nThanks" },
    ]);
    expect(bodyParts("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(bodyParts("```suggestion\n```")).toEqual([{ kind: "suggestion", code: "" }]);
  });

  it("keeps every line between the fences, a blank last one included, and tells an empty block from a blank line", () => {
    const [block] = bodyParts("```suggestion\nnew\n\n```").filter((part) => part.kind === "suggestion") as { code: string }[];
    expect(replaceLines("a\nb\nc\n", 2, 2, "b", block!.code)).toBe("a\nnew\n\nc\n");
    const blank = (bodyParts("```suggestion\n\n```")[0] as { code: string }).code;
    expect(replaceLines("a\nb\nc\n", 2, 2, "b", blank)).toBe("a\n\nc\n");
    const empty = (bodyParts("```suggestion\n```")[0] as { code: string }).code;
    expect(replaceLines("a\nb\nc\n", 2, 2, "b", empty)).toBe("a\nc\n");
    // Applied only when the lines read as suggested, the blank one too.
    expect(suggestionState(block!.code, "new", "b")).toBe("outdated");
    expect(suggestionState(block!.code, "new\n", "b")).toBe("applied");
    expect(suggestionLines("b", block!.code)).toEqual([
      { kind: "del", text: "b" },
      { kind: "add", text: "new" },
      { kind: "add", text: "" },
    ]);
  });

  it("knows whether a suggestion can still be applied", () => {
    expect(suggestionState("b", "a", "a")).toBe("ready");
    expect(suggestionState("b", "b", "a")).toBe("applied");
    expect(suggestionState("b", "c", "a")).toBe("outdated");
    expect(suggestionState("b", undefined, "a")).toBe("unknown");
  });

  it("shows only what changes, between unchanged lines", () => {
    expect(suggestionLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ]);
  });

  it("inserts a block seeded with the lines, on lines of its own", () => {
    expect(insertSuggestion("Try", 3, "x")).toEqual({ body: "Try\n```suggestion\nx\n```", cursor: 18 });
    // The lines are joined with "\n": a trailing one is a blank last line, and it stays.
    expect(insertSuggestion("Try", 3, "x\n")).toEqual({ body: "Try\n```suggestion\nx\n\n```", cursor: 18 });
  });

  describe("from the selected lines to the file, blank lines included", () => {
    /** A new file's patch with these lines, as the tab parses it. */
    const selection = (fileLines: readonly string[], start: number, end: number) => {
      const patch = ["diff --git a/a.ts b/a.ts", "--- /dev/null", "+++ b/a.ts", `@@ -0,0 +1,${fileLines.length} @@`, ...fileLines.map((line) => `+${line}`), ""].join("\n");
      return linesText(parsePatchLines(patch), "new", start, end)!;
    };
    /** The composer's Suggest a change on `text`, then the block as the comment reads it. */
    const seeded = (text: string) => (bodyParts(insertSuggestion("", 0, text).body)[0] as { code: string }).code;
    const edited = (body: string) => (bodyParts(body)[0] as { code: string }).code;

    it("keeps a blank last selected line in the block, shows no change untouched, and applies an edit around it", () => {
      const file = ["const a = 1;", "", "const b = 2;"];
      const text = selection(file, 1, 2);
      expect(text).toBe("const a = 1;\n");
      const code = seeded(text);
      expect(suggestionLines(text, code).every((line) => line.kind === "context")).toBe(true);
      expect(suggestionState(code, text, text)).toBe("applied");
      const change = edited("```suggestion\nconst a = 10;\n\n```");
      expect(suggestionState(change, text, text)).toBe("ready");
      expect(suggestionLines(text, change)).toEqual([
        { kind: "del", text: "const a = 1;" },
        { kind: "add", text: "const a = 10;" },
        { kind: "context", text: "" },
      ]);
      expect(replaceLines(`${file.join("\n")}\n`, 1, 2, text, change)).toBe("const a = 10;\n\nconst b = 2;\n");
    });

    it("treats one blank selected line as a line: kept untouched, removed by an empty block", () => {
      const file = ["a", "", "b"];
      const text = selection(file, 2, 2);
      expect(text).toBe("");
      const code = seeded(text);
      expect(suggestedLinesOf(code)).toEqual([""]);
      expect(suggestionState(code, text, text)).toBe("applied");
      expect(suggestionLines(text, code)).toEqual([{ kind: "context", text: "" }]);
      // An empty block removes the blank line: it is ready, not already applied.
      const removal = edited("```suggestion\n```");
      expect(suggestionState(removal, text, text)).toBe("ready");
      expect(suggestionLines(text, removal)).toEqual([{ kind: "del", text: "" }]);
      expect(replaceLines("a\n\nb\n", 2, 2, text, removal)).toBe("a\nb\n");
      expect(replaceLines("a\n\nb\n", 2, 2, text, code)).toBe("a\n\nb\n");
    });
  });

  it("replaces the lines only while they read as the view showed them", () => {
    expect(replaceLines("a\nb\nc\n", 2, 2, "b", "B\nB2")).toBe("a\nB\nB2\nc\n");
    expect(replaceLines("a\r\nb\r\n", 1, 1, "a", "A")).toBe("A\r\nb\r\n");
    expect(replaceLines("a\nx\nc\n", 2, 2, "b", "B")).toBeNull();
    expect(replaceLines("a\n", 3, 3, "b", "B")).toBeNull();
  });
});

const PATCH = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -6,2 +6,3 @@",
  " six",
  " seven",
  "+eight",
  "",
].join("\n");

describe("reverting hunks", () => {
  const now = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\n";

  it("reads each hunk's sides", () => {
    expect(parseHunks(PATCH).map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([
      [1, ["one", "two", "three"], 1, ["one", "TWO", "three"]],
      [6, ["six", "seven"], 6, ["six", "seven", "eight"]],
    ]);
  });

  it("puts back one hunk, or all of them", () => {
    expect(revertHunks(now, PATCH, [1])).toBe("one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
    expect(revertHunks(now, PATCH, [0])).toBe("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    expect(revertHunks(now, PATCH, [0, 1])).toBe("one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  });

  it("refuses when the file no longer reads as the patch says", () => {
    expect(revertHunks(now.replace("TWO", "2"), PATCH, [0])).toBeNull();
    expect(revertHunks(now, PATCH, [5])).toBeNull();
  });

  it("keeps each line's own ending, and refuses a hunk cut short", () => {
    const mixed = "one\r\nTWO\nthree\n";
    const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");
    expect(revertHunks(mixed, patch, [0])).toBe("one\r\ntwo\nthree\n");
    expect(revertHunks("one\nTWO\nthree\n", ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", ""].join("\n"), [0])).toBeNull();
    expect(replaceLines("a\r\nb\nc", 3, 3, "c", "C\nD")).toBe("a\r\nb\nC\nD");
  });

  it("puts back a removed line's own ending, CRLF or LF, in a partial revert", () => {
    // Two hunks; only the first is reverted. Its old line ended with CRLF, its new one with LF.
    const now = "a\nNEW\nc\nd\ne\nf\ng\nh\nTAIL\n";
    const patch = ["@@ -1,3 +1,3 @@", " a", "-old\r", "+NEW", " c", "@@ -7,3 +7,3 @@", " g", " h", "-tail", "+TAIL", ""].join("\n");
    expect(revertHunks(now, patch, [0])).toBe("a\nold\r\nc\nd\ne\nf\ng\nh\nTAIL\n");
    // And an LF line comes back LF in a CRLF file.
    const crlf = "a\r\nNEW\r\nc\r\n";
    expect(revertHunks(crlf, ["@@ -1,3 +1,3 @@", " a\r", "-old", "+NEW\r", " c\r", ""].join("\n"), [0])).toBe("a\r\nold\nc\r\n");
  });

  it("keeps the end-of-file newline as the old side had it", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", ""].join("\n");
    expect(revertHunks("b\n", patch, [0])).toBe("a");
  });
});
