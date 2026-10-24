import { describe, expect, it } from "vitest";

import { placeThread } from "./anchors";
import { linesText, parsePatchLines } from "./patch-lines";
import { GENERAL_PATH } from "./types";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " ",
  " export { a };",
  "@@ -10,2 +11,2 @@ function f() {",
  "--- not a header, a removed line",
  "+++ not a header, an added line",
  " }",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parsePatchLines", () => {
  it("numbers each side's lines from the hunk headers", () => {
    const lines = parsePatchLines(PATCH);
    expect([...lines.old.entries()]).toEqual([
      [1, "const a = 1;"],
      [2, "const b = 2;"],
      [3, ""],
      [4, "export { a };"],
      [10, "-- not a header, a removed line"],
      [11, "}"],
    ]);
    expect([...lines.new.entries()]).toEqual([
      [1, "const a = 1;"],
      [2, "const b = 3;"],
      [3, "const c = 4;"],
      [4, ""],
      [5, "export { a };"],
      [11, "++ not a header, an added line"],
      [12, "}"],
    ]);
  });

  it("reads a header without counts as one line", () => {
    const lines = parsePatchLines("@@ -3 +3 @@\n-x\n+y\n");
    expect(lines.old.get(3)).toBe("x");
    expect(lines.new.get(3)).toBe("y");
  });

  it("gives a range's text, or null when a line is not shown", () => {
    const lines = parsePatchLines(PATCH);
    expect(linesText(lines, "new", 2, 3)).toBe("const b = 3;\nconst c = 4;");
    expect(linesText(lines, "new", 5, 6)).toBeNull();
  });
});

describe("placeThread", () => {
  const lines = parsePatchLines(PATCH);
  const base = { filePath: "src/a.ts", side: "new" as const, startLine: 2, endLine: 3, anchorContent: "const b = 3;\nconst c = 4;" };

  it("keeps a thread whose text is still there", () => {
    expect(placeThread(base, lines)).toEqual({ state: "anchored", startLine: 2, endLine: 3 });
  });

  it("follows text that moved, to the nearest copy", () => {
    expect(placeThread({ ...base, startLine: 7, endLine: 8 }, lines)).toEqual({ state: "moved", startLine: 2, endLine: 3 });
  });

  it("calls a thread outdated when its text is gone or its file left the diff", () => {
    expect(placeThread({ ...base, anchorContent: "gone" }, lines)).toEqual({ state: "outdated" });
    expect(placeThread(base, undefined)).toEqual({ state: "outdated" });
  });

  it("does not move a blank-line anchor", () => {
    expect(placeThread({ ...base, startLine: 1, endLine: 1, anchorContent: "" }, lines)).toEqual({ state: "outdated" });
    expect(placeThread({ ...base, startLine: 4, endLine: 4, anchorContent: "" }, lines)).toEqual({ state: "anchored", startLine: 4, endLine: 4 });
  });

  it("keeps whole-file and whole-diff threads in place", () => {
    expect(placeThread({ ...base, side: null, startLine: 0, endLine: 0, anchorContent: null }, lines).state).toBe("anchored");
    expect(placeThread({ ...base, filePath: GENERAL_PATH }, undefined).state).toBe("anchored");
  });

  it("checks only that the lines exist when there is no anchor text", () => {
    expect(placeThread({ ...base, anchorContent: null }, lines).state).toBe("anchored");
    expect(placeThread({ ...base, startLine: 40, endLine: 40, anchorContent: null }, lines).state).toBe("outdated");
  });
});
