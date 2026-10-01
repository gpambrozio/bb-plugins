import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { dirsUpToRepoRoot, findRepoRoot, mainCheckoutOf } from "./repo-root";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bb-skills-repo-"));
});

describe("findRepoRoot", () => {
  test("finds the root from a nested directory", async () => {
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "packages", "app", "src");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    expect(await findRepoRoot(nested)).toBe(repo);
  });

  test("matches a .git file, so worktrees and submodules resolve", async () => {
    const repo = path.join(root, "worktree");
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, ".git"), "gitdir: /elsewhere\n", "utf8");

    expect(await findRepoRoot(repo)).toBe(repo);
  });

  test("returns null and stops at the filesystem root when there is no repo", async () => {
    const plain = path.join(root, "no-repo", "deep");
    await mkdir(plain, { recursive: true });

    expect(await findRepoRoot(plain)).toBeNull();
  });
});

describe("dirsUpToRepoRoot", () => {
  test("yields every directory from cwd up to the repository root, cwd first", async () => {
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "app");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    expect(await dirsUpToRepoRoot(cwd)).toEqual([cwd, path.join(repo, "packages"), repo]);
  });

  test("yields the repository root alone when cwd is the root", async () => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });

    expect(await dirsUpToRepoRoot(repo)).toEqual([repo]);
  });

  test("yields cwd alone outside a repository, rather than climbing to /", async () => {
    const plain = path.join(root, "no-repo", "deep");
    await mkdir(plain, { recursive: true });

    expect(await dirsUpToRepoRoot(plain)).toEqual([plain]);
  });
});

describe("mainCheckoutOf", () => {
  test("follows a linked worktree's .git file back to its main checkout", async () => {
    const main = path.join(root, "main");
    const gitDir = path.join(main, ".git", "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n", "utf8");
    const worktree = path.join(root, "elsewhere", "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    expect(await mainCheckoutOf(worktree)).toBe(main);
  });

  test("resolves a relative gitdir from the worktree", async () => {
    const main = path.join(root, "main");
    const gitDir = path.join(main, ".git", "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n", "utf8");
    const worktree = path.join(root, "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), "gitdir: ../main/.git/worktrees/feature\n", "utf8");

    expect(await mainCheckoutOf(worktree)).toBe(main);
  });

  test("answers null for a main checkout", async () => {
    const main = path.join(root, "main");
    await mkdir(path.join(main, ".git"), { recursive: true });

    expect(await mainCheckoutOf(main)).toBeNull();
  });

  test("answers null for a submodule, whose git directory has no commondir", async () => {
    const gitDir = path.join(root, "super", ".git", "modules", "lib");
    await mkdir(gitDir, { recursive: true });
    const submodule = path.join(root, "super", "lib");
    await mkdir(submodule, { recursive: true });
    await writeFile(path.join(submodule, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    expect(await mainCheckoutOf(submodule)).toBeNull();
  });

  test("answers null for a worktree of a bare repository", async () => {
    const bare = path.join(root, "repo.git");
    const gitDir = path.join(bare, "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n", "utf8");
    const worktree = path.join(root, "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    expect(await mainCheckoutOf(worktree)).toBeNull();
  });

  test("answers null for a .git file that names no git directory", async () => {
    const odd = path.join(root, "odd");
    await mkdir(odd, { recursive: true });
    await writeFile(path.join(odd, ".git"), "not a pointer\n", "utf8");

    expect(await mainCheckoutOf(odd)).toBeNull();
  });
});
