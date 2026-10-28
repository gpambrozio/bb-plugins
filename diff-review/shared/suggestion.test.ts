import { describe, expect, it } from "vitest";

import { parseHunks, revertHunks } from "./revert";
import { bodyParts, insertSuggestion, replaceLines, suggestionLines, suggestionState } from "./suggestion";

describe("suggested changes", () => {
  it("splits a comment into text and suggestion blocks", () => {
    expect(bodyParts("Use a const:\n```suggestion\nconst b = 3;\n```\nThanks")).toEqual([
      { kind: "text", text: "Use a const:\n" },
      { kind: "suggestion", code: "const b = 3;" },
      { kind: "text", text: "\nThanks" },
    ]);
    expect(bodyParts("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(bodyParts("```suggestion\n```")).toEqual([{ kind: "suggestion", code: "" }]);
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
    expect(insertSuggestion("Try", 3, "x\n")).toEqual({ body: "Try\n```suggestion\nx\n```", cursor: 18 });
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

  it("keeps the end-of-file newline as the old side had it", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", ""].join("\n");
    expect(revertHunks("b\n", patch, [0])).toBe("a");
  });
});
