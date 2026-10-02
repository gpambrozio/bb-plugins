import { stat } from "node:fs/promises";
import path from "node:path";

import { readBoundedText } from "./read-bounded";

/** A `.git` pointer or a `commondir` is one short line. */
const MAX_POINTER_BYTES = 64 * 1024;

/**
 * Walks up from cwd looking for a `.git` entry. Matches a file as well as a
 * directory so worktrees and submodules resolve. Stops at the filesystem root.
 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Every directory from cwd up to the repository root, cwd first. Both providers
 * scan their skills directory in each of these, not only in cwd — a skill
 * checked in at the repo root is available to an agent working in a
 * subdirectory. Outside a repository the walk has nowhere to stop, so it yields
 * cwd alone rather than climbing to the filesystem root.
 */
export async function dirsUpToRepoRoot(cwd: string): Promise<string[]> {
  const start = path.resolve(cwd);
  const repoRoot = await findRepoRoot(start);
  if (!repoRoot || repoRoot === start) return [start];

  const dirs = [start];
  let current = start;
  while (current !== repoRoot) {
    const parent = path.dirname(current);
    if (parent === current) break;
    dirs.push(parent);
    current = parent;
  }
  return dirs;
}

/**
 * The main checkout a linked worktree belongs to, or null when `repoRoot` is
 * not a linked worktree. A worktree's `.git` is a file naming its git
 * directory (`<main>/.git/worktrees/<name>`), which holds a `commondir` back
 * to the shared `<main>/.git`. A submodule's `.git` is a file too, but its git
 * directory has no `commondir`, and a bare repository's common directory is
 * not a `.git` inside a checkout — both answer null.
 *
 * Read from the files rather than asked of `git`, so discovery spawns nothing,
 * and read bounded: the worktree's `.git` is the workspace's to plant.
 */
export async function mainCheckoutOf(repoRoot: string): Promise<string | null> {
  // A `.git` directory reads as null: this is the main checkout itself.
  const pointer = await readBoundedText(path.join(repoRoot, ".git"), MAX_POINTER_BYTES);
  if (pointer === null) return null;
  const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(repoRoot, gitDir);
  const common = await readBoundedText(path.join(resolvedGitDir, "commondir"), MAX_POINTER_BYTES);
  if (common === null) return null;
  const commonDir = path.resolve(resolvedGitDir, common.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
}
