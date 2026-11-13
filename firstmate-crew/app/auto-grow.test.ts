import { describe, expect, it } from "vitest";

import { isInsertion } from "./auto-grow";

describe("isInsertion", () => {
  it("is text added at one place: the end, the start or the middle", () => {
    expect(isInsertion("", "a")).toBe(true);
    expect(isInsertion("Merge", "Merge it")).toBe(true);
    expect(isInsertion("it", "Merge it")).toBe(true);
    expect(isInsertion("Merge it", "Merge all of it")).toBe(true);
    expect(isInsertion("aa", "aaa")).toBe(true);
  });

  it("is not a deletion, an unchanged text, or a replacement of any length", () => {
    expect(isInsertion("Merge it", "Merge")).toBe(false);
    expect(isInsertion("Merge it", "Merge it")).toBe(false);
    expect(isInsertion("Merge when all checks are green.", "I'll merge it if CI is still green.")).toBe(false);
    expect(isInsertion("abc", "abxd")).toBe(false);
  });
});
