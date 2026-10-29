import { describe, expect, it } from "vitest";

import { fileRef } from "./open-file";

describe("which version Open shows", () => {
  const modified = { changeKind: "modified" as const };
  const deleted = { changeKind: "deleted" as const };

  it("shows the working copy where the view compares against it, HEAD for a file deleted there", () => {
    expect(fileRef({ kind: "uncommitted" }, modified, null)).toEqual({ ref: null });
    expect(fileRef({ kind: "uncommitted" }, deleted, null)).toEqual({ ref: "HEAD" });
    expect(fileRef({ kind: "all", base: "main" }, modified, "1234abcd")).toEqual({ ref: null });
  });

  it("shows the branch's committed version, and a deleted file at the merge base", () => {
    expect(fileRef({ kind: "branch", base: "main" }, modified, "1234abcd")).toEqual({ ref: "HEAD" });
    expect(fileRef({ kind: "branch", base: "main" }, deleted, "1234abcd")).toEqual({ ref: "1234abcd" });
    expect(fileRef({ kind: "all", base: "main" }, deleted, null)).toBeNull();
  });

  it("shows a commit's version, and nothing for a file the commit deleted", () => {
    expect(fileRef({ kind: "commit", sha: "abcdef1" }, modified, null)).toEqual({ ref: "abcdef1" });
    expect(fileRef({ kind: "commit", sha: "abcdef1" }, deleted, null)).toBeNull();
  });
});
