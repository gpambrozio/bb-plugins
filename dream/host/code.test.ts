import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeSource } from "./code";

let root: string;
let origin: string;
let checkout: string;
let codeDir: string;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" }).trim();
}

let tick = 0;
function commit(dir: string, file: string, content: string): string {
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  tick += 1;
  const date = `2026-11-${String(tick).padStart(2, "0")}T12:00:00Z`;
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", file], { env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(dir, "rev-parse", "HEAD");
}

/** Every file under `dir` with its mtime, to prove a read touched nothing. */
function snapshot(dir: string): Record<string, number> {
  const files: Record<string, number> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = statSync(full).mtimeMs;
    }
  };
  walk(dir);
  return files;
}

beforeEach(() => {
  tick = 0;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-code-")));
  origin = path.join(root, "origin");
  checkout = path.join(root, "checkout");
  codeDir = path.join(root, "cache", "code", "proj_app");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  commit(origin, "README.md", "v1\n");
  execFileSync("git", ["clone", "-q", origin, checkout], { env });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the code a dream reads", () => {
  it("reads the checkout itself when it is on the newest default-branch commit", async () => {
    const code = await codeSource({ checkout, projectCodeDir: codeDir });
    expect(code).toMatchObject({ dir: checkout, kind: "checkout", branch: "main", ref: "main", note: null });
    expect(existsSync(codeDir)).toBe(false);
  });

  it("copies the remote-tracking branch when another fetch moved it past a stale checkout, writing nothing in the repository", async () => {
    const stale = git(checkout, "rev-parse", "HEAD");
    const newest = commit(origin, "src.txt", "new code\n");
    // A worktree's fetch updates the shared origin/main; the checkout's own branch stays behind.
    git(checkout, "fetch", "-q", "origin");
    const before = snapshot(checkout);

    const code = await codeSource({ checkout, projectCodeDir: codeDir });

    expect(code).toMatchObject({ kind: "copy", branch: "main", ref: "origin/main", commit: newest, checkoutCommit: stale, note: null });
    expect(code.dir).toBe(path.join(codeDir, newest));
    expect(readFileSync(path.join(code.dir, "src.txt"), "utf8")).toBe("new code\n");
    expect(existsSync(path.join(checkout, "src.txt"))).toBe(false);
    expect(snapshot(checkout)).toEqual(before);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(stale);
  });

  it("reuses a finished copy and removes older ones when the branch moves on", async () => {
    commit(origin, "a.txt", "a\n");
    git(checkout, "fetch", "-q", "origin");
    const first = await codeSource({ checkout, projectCodeDir: codeDir });
    const again = await codeSource({ checkout, projectCodeDir: codeDir });
    expect(again.dir).toBe(first.dir);
    commit(origin, "b.txt", "b\n");
    git(checkout, "fetch", "-q", "origin");
    const moved = await codeSource({ checkout, projectCodeDir: codeDir });
    expect(moved.dir).not.toBe(first.dir);
    expect(readdirSync(codeDir)).toEqual([path.basename(moved.dir)]);
  });

  it("prefers the local branch when it is ahead of the remote-tracking one, and needs no remote", async () => {
    const local = path.join(root, "local");
    mkdirSync(local);
    git(local, "init", "-q", "-b", "main");
    commit(local, "one.txt", "1\n");
    git(local, "checkout", "-q", "-b", "feature");
    commit(local, "feature.txt", "f\n");
    git(local, "checkout", "-q", "main");
    const tip = commit(local, "two.txt", "2\n");
    git(local, "checkout", "-q", "feature");

    const code = await codeSource({ checkout: local, projectCodeDir: codeDir });
    expect(code).toMatchObject({ kind: "copy", branch: "main", ref: "main", commit: tip });
    expect(existsSync(path.join(code.dir, "two.txt"))).toBe(true);
    expect(existsSync(path.join(code.dir, "feature.txt"))).toBe(false);
  });

  it("reads the checkout in the copy's same folder when the project is below the repository's top", async () => {
    mkdirSync(path.join(origin, "app"));
    commit(origin, "app/index.txt", "old\n");
    git(checkout, "pull", "-q", "--ff-only");
    commit(origin, "app/index.txt", "app\n");
    git(checkout, "fetch", "-q", "origin");
    const code = await codeSource({ checkout: path.join(checkout, "app"), projectCodeDir: codeDir });
    expect(code).toMatchObject({ kind: "copy", note: null });
    expect(code.dir.endsWith(`${path.sep}app`)).toBe(true);
    expect(readFileSync(path.join(code.dir, "index.txt"), "utf8")).toBe("app\n");
  });

  it("falls back to the checkout, saying why, when there is nothing better to read", async () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    expect(await codeSource({ checkout: plain, projectCodeDir: codeDir })).toMatchObject({ dir: plain, kind: "checkout", note: "the checkout is not a git repository" });

    commit(origin, "big.txt", "x".repeat(2048));
    git(checkout, "fetch", "-q", "origin");
    const tooBig = await codeSource({ checkout, projectCodeDir: codeDir, maxBytes: 1024 });
    expect(tooBig).toMatchObject({ dir: checkout, kind: "checkout", ref: "origin/main" });
    expect(tooBig.note).toMatch(/too large to copy/);
    expect(existsSync(codeDir)).toBe(false);
  });
});
