import { describe, expect, it } from "vitest";

import { lineDiff, MAX_CELLS } from "./line-diff";

const kinds = (rows: ReturnType<typeof lineDiff>) => rows.map((row) => (row.kind === "skip" ? `skip ${row.count}` : `${row.kind} ${row.text}`));

describe("lineDiff", () => {
  it("marks changed lines and keeps the rest as context", () => {
    expect(kinds(lineDiff("a\nb\nc\n", "a\nB\nc\n"))).toEqual(["same a", "del b", "add B", "same c"]);
  });

  it("shows a new file as all added and a deleted one as all removed", () => {
    expect(kinds(lineDiff(null, "x\ny\n"))).toEqual(["add x", "add y"]);
    expect(kinds(lineDiff("x\n", null))).toEqual(["del x"]);
    expect(lineDiff("same\n", "same\n").filter((row) => row.kind !== "same" && row.kind !== "skip")).toEqual([]);
  });

  it("folds long runs of unchanged lines to three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    expect(kinds(lineDiff(before, after))).toEqual([
      "skip 7",
      "same line 7",
      "same line 8",
      "same line 9",
      "del line 10",
      "add line ten",
      "same line 11",
      "same line 12",
      "same line 13",
      "skip 6",
    ]);
  });

  it("numbers lines on each side", () => {
    const rows = lineDiff("a\nb\n", "a\nx\nb\n");
    expect(rows).toContainEqual({ kind: "add", text: "x", oldLine: null, newLine: 2 });
    expect(rows).toContainEqual({ kind: "same", text: "b", oldLine: 2, newLine: 3 });
  });

  it("shows old then new without comparing past the size limit", () => {
    const side = Math.ceil(Math.sqrt(MAX_CELLS)) + 1;
    const before = Array.from({ length: side }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: side }, (_, index) => `b${index}`).join("\n");
    const rows = lineDiff(before, after, 0);
    expect(rows.filter((row) => row.kind === "del")).toHaveLength(side);
    expect(rows.filter((row) => row.kind === "add")).toHaveLength(side);
  });
});
