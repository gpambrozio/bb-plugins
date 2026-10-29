import { describe, expect, it } from "vitest";

import { carryCurrent, findInFiles } from "./find";

const PATCH = ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = A;", ""].join("\n");

describe("find across the diff", () => {
  it("finds every match in the order the diff shows its lines, by side and line", () => {
    const { matches, truncated } = findInFiles([{ path: "a.ts", patch: PATCH }, { path: "b.ts", patch: null }], "const b", false);
    expect(truncated).toBe(false);
    expect(matches.map((match) => [match.path, match.side, match.line, match.kind, match.start])).toEqual([
      ["a.ts", "old", 2, "deletion", 0],
      ["a.ts", "new", 2, "addition", 0],
    ]);
  });

  it("ignores case unless asked, and stops at the limit", () => {
    expect(findInFiles([{ path: "a.ts", patch: PATCH }], "a", false).matches).toHaveLength(2);
    expect(findInFiles([{ path: "a.ts", patch: PATCH }], "A", true).matches.map((match) => match.line)).toEqual([3]);
    expect(findInFiles([{ path: "a.ts", patch: PATCH }], "const", false, 2)).toMatchObject({ truncated: true, matches: [{}, {}] });
  });

  it("keeps the current match across a reload", () => {
    const first = findInFiles([{ path: "a.ts", patch: PATCH }], "const", false).matches;
    const again = findInFiles([{ path: "z.ts", patch: PATCH }, { path: "a.ts", patch: PATCH }], "const", false).matches;
    expect(carryCurrent(first[2]!, again)).toBe(6);
    expect(carryCurrent(null, again)).toBe(-1);
  });
});
