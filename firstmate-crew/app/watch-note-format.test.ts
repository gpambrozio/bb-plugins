import { describe, expect, it } from "vitest";

import { codeBlock, keepLineBreaks, watchNoteFile } from "./watch-note-format";

function resource(value: unknown): string {
  return JSON.stringify(value);
}

describe("watchNoteFile", () => {
  const chip = {
    kind: "path",
    source: "workspace",
    entryKind: "file",
    path: ".firstmate/watch-notes/2026-09-30T06-40-12Z.md",
    label: "full note",
  };

  it("is the note's file name for a watch note chip", () => {
    expect(watchNoteFile(resource(chip))).toBe("2026-09-30T06-40-12Z.md");
    expect(watchNoteFile(resource({ ...chip, path: ".firstmate/watch-notes/2026-09-30T06-40-12Z-2.md" }))).toBe(
      "2026-09-30T06-40-12Z-2.md",
    );
  });

  it("is null for any other chip", () => {
    expect(watchNoteFile(resource({ ...chip, path: "src/index.ts" }))).toBeNull();
    expect(watchNoteFile(resource({ ...chip, path: ".firstmate/watch-notes/../watches.json" }))).toBeNull();
    expect(watchNoteFile(resource({ ...chip, source: "thread-storage" }))).toBeNull();
    expect(watchNoteFile(resource({ kind: "thread", threadId: "thr_1", label: "x" }))).toBeNull();
  });

  it("is null for a missing or unreadable attribute", () => {
    expect(watchNoteFile(null)).toBeNull();
    expect(watchNoteFile("{nope")).toBeNull();
    expect(watchNoteFile("3")).toBeNull();
  });
});

describe("keepLineBreaks", () => {
  it("ends each line that runs on into another with a Markdown hard break", () => {
    expect(keepLineBreaks("header:\n- one\n- two\n\nlink a\nlink b")).toBe("header:  \n- one  \n- two\n\nlink a  \nlink b");
  });

  it("leaves fenced code as it is", () => {
    expect(keepLineBreaks("before\n```\ncode a\ncode b\n```\nafter")).toBe("before\n```\ncode a\ncode b\n```\nafter");
  });

  it("trims the output's surrounding blank lines", () => {
    expect(keepLineBreaks("\n\nonly\n\n")).toBe("only");
  });
});

describe("codeBlock", () => {
  it("fences the text", () => {
    expect(codeBlock("exit 2")).toBe("```\nexit 2\n```");
  });

  it("uses a longer fence than any backticks in the text", () => {
    expect(codeBlock("a ```` b")).toBe("`````\na ```` b\n`````");
  });
});
