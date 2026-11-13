import { describe, expect, it } from "vitest";

import { isAppend } from "./auto-grow";

describe("isAppend", () => {
  it("is letters typed at the end", () => {
    expect(isAppend("", "a")).toBe(true);
    expect(isAppend("Merge", "Merge.")).toBe(true);
    expect(isAppend("Merge it", "Merge itself")).toBe(true);
  });

  it("is not whitespace, an edit inside the text, a deletion, an unchanged text or a replacement", () => {
    expect(isAppend("Merge", "Merge ")).toBe(false);
    expect(isAppend("Merge", "Merge\n")).toBe(false);
    expect(isAppend("the releasenotes", "the release notes")).toBe(false);
    expect(isAppend("it", "Merge it")).toBe(false);
    expect(isAppend("Merge it", "Merge")).toBe(false);
    expect(isAppend("Merge it", "Merge it")).toBe(false);
    expect(isAppend("Merge when all checks are green.", "I'll merge it if CI is still green.")).toBe(false);
  });
});
