import { describe, expect, it } from "vitest";
import { checkListing, sha256, sliceLines } from "./orientation-verify";

const file = ["a", "b", "c", "d", "e"].join("\n");
const listing = { startLine: 2, endLine: 3, text: "b\nc", sha256: sha256("b\nc") };

describe("checkListing", () => {
  it("is current when the range still holds the text", () =>
    expect(checkListing(file, listing)).toEqual({ state: "current", startLine: 2, endLine: 3 }));
  it("is moved when lines were inserted above", () =>
    expect(checkListing(`x\ny\n${file}`, listing)).toEqual({ state: "moved", startLine: 4, endLine: 5 }));
  it("picks the hit nearest the old start", () =>
    expect(checkListing("b\nc\nz\nz\nz\nb\nc", { ...listing, startLine: 6, endLine: 7 }).startLine).toBe(6));
  it("breaks ties toward the earlier hit", () =>
    expect(checkListing("b\nc\nz\nz\nb\nc", { ...listing, startLine: 3, endLine: 4 }).startLine).toBe(1));
  it("is changed when the text is gone", () =>
    expect(checkListing("a\nB\nc", listing)).toEqual({ state: "changed", startLine: null, endLine: null }));
  it("is missing when the file cannot be read", () => expect(checkListing(null, listing).state).toBe("missing"));
  it("is changed, not thrown, when the file shrank below the range", () =>
    expect(checkListing("a", listing).state).toBe("changed"));
  it("treats CRLF files as their LF text", () =>
    expect(checkListing(file.replace(/\n/g, "\r\n"), listing).state).toBe("current"));
  it("does not match a partial line", () =>
    expect(checkListing("ab\nc", { ...listing, startLine: 1, endLine: 2 }).state).toBe("changed"));
});

describe("sliceLines", () => {
  it("returns a 1-based inclusive range", () => expect(sliceLines(file, 2, 3)).toBe("b\nc"));
  it("strips a trailing CR from each line", () => expect(sliceLines("a\r\nb\r\n", 1, 2)).toBe("a\nb"));
  it("does not count the empty element after a final newline", () => {
    expect(sliceLines("a\nb\n", 1, 2)).toBe("a\nb");
    expect(sliceLines("a\nb\n", 1, 3)).toBeNull();
  });
  it("is null when end exceeds the line count", () => expect(sliceLines("a", 1, 2)).toBeNull());
});
