import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitIn, type Git } from "./code";
import { copyTree, TreeTooLargeError, UnsafeTreeError } from "./tree-copy";

let root: string;
let repo: string;
let target: string;

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
}

function commitAll(): string {
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dream-tree-")));
  repo = path.join(root, "repo");
  target = path.join(root, "copy");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a commit's tree copy", () => {
  it("copies files byte for byte, keeps the executable bit and links, and leaves submodule-free folders as they are", async () => {
    mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    writeFileSync(path.join(repo, "src", "deep", "a.bin"), Buffer.from([0, 1, 2, 10, 255]));
    writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(repo, "empty.txt"), "");
    symlinkSync("src/deep/a.bin", path.join(repo, "link"));
    const commit = commitAll();

    const result = await copyTree({ git: gitIn(repo), repo, commit, target, maxBytes: 1024, maxEntries: 10 });

    expect(result.files).toBe(4);
    expect(readFileSync(path.join(target, "src", "deep", "a.bin"))).toEqual(Buffer.from([0, 1, 2, 10, 255]));
    expect(statSync(path.join(target, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(target, "empty.txt"), "utf8")).toBe("");
    expect(lstatSync(path.join(target, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(target, "link"))).toBe("src/deep/a.bin");
  });

  it("stops writing at the limit even when the listing understates the sizes", async () => {
    writeFileSync(path.join(repo, "one.txt"), "x".repeat(2048));
    writeFileSync(path.join(repo, "two.txt"), "y".repeat(2048));
    const commit = commitAll();
    const real = gitIn(repo);
    // A listing that claims every file is one byte: only the bytes really written can stop the copy.
    const lying: Git = async (args, options) => {
      const result = await real(args, options);
      return args[0] === "ls-tree" ? { ...result, stdout: result.stdout.replace(/ +\d+\t/g, "       1\t") } : result;
    };
    await expect(copyTree({ git: lying, repo, commit, target, maxBytes: 3000, maxEntries: 10 })).rejects.toBeInstanceOf(TreeTooLargeError);
  });

  it("refuses a listing over the file count or the byte limit before writing anything", async () => {
    writeFileSync(path.join(repo, "a.txt"), "a");
    writeFileSync(path.join(repo, "b.txt"), "b".repeat(100));
    const commit = commitAll();
    await expect(copyTree({ git: gitIn(repo), repo, commit, target, maxBytes: 1024, maxEntries: 1 })).rejects.toBeInstanceOf(TreeTooLargeError);
    await expect(copyTree({ git: gitIn(repo), repo, commit, target, maxBytes: 50, maxEntries: 10 })).rejects.toBeInstanceOf(TreeTooLargeError);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a path that would leave the copy or write into a .git folder", async () => {
    writeFileSync(path.join(repo, "a.txt"), "a");
    const commit = commitAll();
    const real = gitIn(repo);
    for (const evil of ["../outside.txt", "sub/.GIT/config", "a//b"]) {
      const forged: Git = async (args, options) => {
        const result = await real(args, options);
        return args[0] === "ls-tree" ? { ...result, stdout: result.stdout.replace(/\ta\.txt\0/, `\t${evil}\0`) } : result;
      };
      await expect(copyTree({ git: forged, repo, commit, target, maxBytes: 1024, maxEntries: 10 })).rejects.toBeInstanceOf(UnsafeTreeError);
    }
    expect(existsSync(path.join(root, "outside.txt"))).toBe(false);
  });

  it("never writes a file through a tracked link", async () => {
    writeFileSync(path.join(repo, "a.txt"), "a");
    const commit = commitAll();
    const real = gitIn(repo);
    // A forged tree with a link `out` to the folder above and a file `out/x.txt` behind it.
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env, input: outside, encoding: "utf8" }).trim();
    const forged: Git = async (args, options) => {
      const result = await real(args, options);
      if (args[0] !== "ls-tree") return result;
      const file = /^100644 blob ([0-9a-f]+)/.exec(result.stdout)?.[1] as string;
      return { ...result, stdout: `120000 blob ${blob} ${outside.length}\tout\x00100644 blob ${file}       1\tout/x.txt\x00` };
    };
    await expect(copyTree({ git: forged, repo, commit, target, maxBytes: 1024, maxEntries: 10 })).rejects.toThrow();
    expect(existsSync(path.join(outside, "x.txt"))).toBe(false);
  });
});
