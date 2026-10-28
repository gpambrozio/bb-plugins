import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRunGit, type RunGit } from "./git";
import { currentRevision, revert } from "./revert";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).trim();
}

/** A repository with `a.txt` and `b.txt` committed, and `link` pointing at `a.txt`. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  writeFileSync(join(root, "b.txt"), "bee\n");
  symlinkSync("a.txt", join(root, "link"));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

const run = createRunGit();

describe("reverting on the host", () => {
  it("computes the revision bb's Git plugin lists: modes and blobs, the working copy hashed as git does", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    expect(await currentRevision(run, root, "a.txt")).toBe(`100644:${git(root, "rev-parse", "HEAD:a.txt")}:100644:${git(root, "hash-object", "a.txt")}`);
    writeFileSync(join(root, "new.txt"), "fresh\n");
    expect(await currentRevision(run, root, "new.txt")).toBe(`000000:${"0".repeat(40)}:100644:${git(root, "hash-object", "new.txt")}`);
  });

  it("puts a whole file back, removes a new one and restores a deleted one, at the reviewed revision", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "changed\n");
    await revert(run, { root, path: "a.txt", revision: await currentRevision(run, root, "a.txt"), hunks: null, patch: null });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");
    await revert(run, { root, path: "new.txt", revision: await currentRevision(run, root, "new.txt"), hunks: null, patch: null });
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    unlinkSync(join(root, "b.txt"));
    await revert(run, { root, path: "b.txt", revision: await currentRevision(run, root, "b.txt"), hunks: null, patch: null });
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("bee\n");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("refuses a symlink whose target changed, and writes neither file", async () => {
    const root = repo();
    unlinkSync(join(root, "link"));
    symlinkSync("b.txt", join(root, "link"));
    const revision = await currentRevision(run, root, "link");
    expect(revision).toContain(":120000:");
    await expect(revert(run, { root, path: "link", revision, hunks: null, patch: null })).rejects.toThrow("symlink");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("bee\n");
    expect(readlinkSync(join(root, "link"))).toBe("b.txt");
  });

  it("refuses when the file changed after the tab's revision, and keeps the new edit", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
    await expect(revert(run, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("refuses when the file is saved while the committed version is being read, and keeps that save", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    // An editor saves during the `git cat-file` the revert awaits.
    const racing: RunGit = async (where, args, options) => {
      if (args[0] === "cat-file") writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
      return run(where, args, options);
    };
    await expect(revert(racing, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("does not delete a new file that was edited after the review", async () => {
    const root = repo();
    writeFileSync(join(root, "new.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "new.txt");
    writeFileSync(join(root, "new.txt"), "more work\n");
    await expect(revert(run, { root, path: "new.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("more work\n");
  });

  it("reverts picked hunks of the reviewed version only", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    const patch = git(root, "diff", "HEAD", "--", "a.txt") + "\n";
    await revert(run, { root, path: "a.txt", revision: await currentRevision(run, root, "a.txt"), hunks: [0], patch });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("refuses a staged file saved again after git's diff read it, keeping that save", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    git(root, "add", "a.txt");
    const revision = await currentRevision(run, root, "a.txt");
    // git reports the staged blob; an editor saves right after that read.
    const racing: RunGit = async (where, args, options) => {
      const result = await run(where, args, options);
      if (args[0] === "diff" && args.includes("--raw")) writeFileSync(join(root, "a.txt"), "NEW UNREVIEWED EDIT\n");
      return result;
    };
    await expect(revert(racing, { root, path: "a.txt", revision, hunks: null, patch: null })).rejects.toThrow("changed since");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("NEW UNREVIEWED EDIT\n");
  });

  it("hashes the working file as bb does, its attributes applied, so a CRLF-normalized file reverts", async () => {
    const root = repo();
    writeFileSync(join(root, ".gitattributes"), "a.txt text eol=crlf\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-q", "-m", "attributes");
    writeFileSync(join(root, "a.txt"), "one\r\nTWO\r\n");
    const revision = await currentRevision(run, root, "a.txt");
    // bb's Git plugin runs `git hash-object -- a.txt`, which normalizes CRLF to LF.
    expect(revision).toBe(`100644:${git(root, "rev-parse", "HEAD:a.txt")}:100644:${git(root, "hash-object", "a.txt")}`);
    await revert(run, { root, path: "a.txt", revision, hunks: null, patch: null });
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe("");
  });

  it("never writes through a symlinked folder, leaving the folder it points at untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "diff-review-revert-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a.txt"), "inside\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    const outside = mkdtempSync(join(tmpdir(), "diff-review-outside-"));
    roots.push(outside);
    rmSync(join(root, "dir"), { recursive: true });
    symlinkSync(outside, join(root, "dir"));
    // git now reports dir/a.txt deleted.
    const revision = await currentRevision(run, root, "dir/a.txt");
    await expect(revert(run, { root, path: "dir/a.txt", revision, hunks: null, patch: null })).rejects.toThrow("symlinked folder");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not write through a file or link already at the temporary file's name", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    const revision = await currentRevision(run, root, "a.txt");
    const victim = join(mkdtempSync(join(tmpdir(), "diff-review-victim-")), "victim.txt");
    roots.push(dirname(victim));
    writeFileSync(victim, "precious\n");
    const planted = join(root, ".planted.tmp");
    symlinkSync(victim, planted);
    await expect(revert(run, { root, path: "a.txt", revision, hunks: null, patch: null }, { temporaryName: () => planted })).rejects.toThrow("temporary file");
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("reviewed\n");
    expect(readlinkSync(planted)).toBe(victim);
  });

  it("refuses a path outside the workspace", async () => {
    const root = repo();
    await expect(revert(run, { root, path: "../x", revision: "r", hunks: null, patch: null })).rejects.toThrow("not a file of this workspace");
  });
});
