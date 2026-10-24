import { describe, expect, it } from "vitest";

import { ignoreMatcher, patternLines } from "./ignore";

describe("patternLines", () => {
  it("drops blank lines and comments", () => {
    expect(patternLines("# generated\n\n*.lock\r\n  dist/  \n  # indented comment\n")).toEqual(["*.lock", "  dist/"]);
  });
});

describe("ignoreMatcher", () => {
  it("matches gitignore patterns against workspace paths", () => {
    const ignored = ignoreMatcher(["*.lock", "dist/", "!keep.lock"]);
    expect(ignored("package.lock")).toBe(true);
    expect(ignored("keep.lock")).toBe(false);
    expect(ignored("dist/app.js")).toBe(true);
    expect(ignored("./dist/app.js")).toBe(true);
    expect(ignored("src/app.ts")).toBe(false);
  });

  it("ignores nothing without patterns, and never a path it cannot judge", () => {
    expect(ignoreMatcher([])("anything")).toBe(false);
    expect(ignoreMatcher(["*"])("/abs/path")).toBe(false);
    expect(ignoreMatcher(["*"])("../up")).toBe(false);
  });
});
