/**
 * The code a dream checks memories against: the newest copy of the project's default branch the
 * repository already has, which is often not the checkout. A checkout can sit on an old commit for
 * months while the project moves on in worktrees, whose fetches update the shared remote-tracking
 * branch. So the default branch's local branch and its remote-tracking branches are compared, and the
 * newest wins.
 *
 * - **No network, ever.** Nothing fetches: the copy is as fresh as the repository's last fetch, by
 *   anyone. A repository with no remote just uses its local branch.
 * - **The checkout is only read.** Every git command here reads (`symbolic-ref`, `rev-parse`,
 *   `merge-base`, `log`, `ls-tree`, `cat-file`), with `GIT_OPTIONAL_LOCKS=0` so none refreshes the
 *   index. When the checkout's HEAD is already that commit, the dream reads the checkout itself.
 *   Otherwise the commit's tree is copied, file by file as git stores it, into
 *   `<code root>/<project>/tree-<commit>/`, a folder outside the repository and bb's data folder
 *   (host/tree-copy.ts). Not `git archive`: its `export-ignore` drops tracked files and its
 *   `export-subst` grows them past any limit. The copy is reused while the commit stays the newest,
 *   and older copies of the project are removed.
 * - **Anything unexpected falls back to the checkout**, with a note the prompt passes on: not a git
 *   repository, no default branch, a copy that would write over `MAX_CODE_BYTES` or `MAX_CODE_FILES`,
 *   or a failing command. Never fails a dream.
 *
 * Submodules and untracked files are not in a copy.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import type { CodeSource } from "../shared/types";
import { copyTree, TreeTooLargeError } from "./tree-copy";

export type { CodeSource };

/** A copy may write no more than this, counted as it writes; past it the dream reads the checkout. */
export const MAX_CODE_BYTES = 1024 * 1024 * 1024;
/** Nor more files than this. */
export const MAX_CODE_FILES = 200_000;
const GIT_TIMEOUT_MS = 30_000;
const BRANCH_GUESSES = ["main", "master"];

export type Git = (args: string[], options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string }>;

/** Runs `git -C <dir>`, read-only, with no prompt for credentials and no optional locks. */
export function gitIn(dir: string, gitPath = "git"): Git {
  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        gitPath,
        ["-C", dir, ...args],
        {
          timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== "number") {
            reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
            return;
          }
          resolve({ code: error ? Number((error as { code: number }).code) : 0, stdout: String(stdout) });
        },
      );
    });
}

async function line(git: Git, args: string[]): Promise<string | null> {
  const result = await git(args);
  const text = result.stdout.trim();
  return result.code === 0 && text !== "" ? text : null;
}

async function commitOf(git: Git, ref: string): Promise<string | null> {
  return line(git, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
}

async function commitTime(git: Git, commit: string): Promise<number | null> {
  const text = await line(git, ["log", "-1", "--no-show-signature", "--format=%ct", commit]);
  return text === null || !/^\d+$/.test(text) ? null : Number(text) * 1000;
}

/** The default branch's name: the one `origin/HEAD` names, else `main` or `master` where present. */
async function defaultBranch(git: Git): Promise<string | null> {
  const remoteHead = await line(git, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead !== null && remoteHead.includes("/")) return remoteHead.slice(remoteHead.indexOf("/") + 1);
  for (const name of BRANCH_GUESSES) {
    if ((await commitOf(git, `refs/heads/${name}`)) !== null || (await commitOf(git, `refs/remotes/origin/${name}`)) !== null) return name;
  }
  return null;
}

/** The local branch, its upstream, and `origin/<branch>`, as refs that exist. */
async function candidates(git: Git, branch: string): Promise<{ ref: string; commit: string }[]> {
  const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  const upstream = await line(git, ["rev-parse", "-q", "--symbolic-full-name", `refs/heads/${branch}@{upstream}`]);
  if (upstream !== null && upstream.startsWith("refs/remotes/")) refs.push(upstream);
  const found: { ref: string; commit: string }[] = [];
  for (const ref of [...new Set(refs)]) {
    const commit = await commitOf(git, ref);
    if (commit !== null) found.push({ ref: ref.replace(/^refs\/(heads|remotes)\//, ""), commit });
  }
  return found;
}

async function isAncestor(git: Git, older: string, newer: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", older, newer])).code === 0;
}

/** The newest of the candidates: a descendant beats its ancestor; diverged ones go by commit time. */
async function newest(git: Git, found: { ref: string; commit: string }[]): Promise<{ ref: string; commit: string }> {
  let best = found[0];
  for (const next of found.slice(1)) {
    if (next.commit === best.commit) continue;
    if (await isAncestor(git, best.commit, next.commit)) best = next;
    else if (await isAncestor(git, next.commit, best.commit)) continue;
    else if (((await commitTime(git, next.commit)) ?? 0) > ((await commitTime(git, best.commit)) ?? 0)) best = next;
  }
  return best;
}

/**
 * A copy's folder name. The `tree-` prefix marks copies made by host/tree-copy.ts: a folder named by
 * the bare commit was made by `git archive` (attributes applied, LFS smudged) and is never reused.
 */
export function copyName(commit: string): string {
  return `tree-${commit}`;
}

/**
 * Copies `commit` into `<projectCodeDir>/tree-<commit>/`, reusing a finished copy, and removes older ones.
 * A failed or oversized copy leaves nothing behind.
 */
async function exportCommit(git: Git, repo: string, projectCodeDir: string, commit: string, maxBytes: number): Promise<string> {
  const name = copyName(commit);
  const target = path.join(projectCodeDir, name);
  mkdirSync(projectCodeDir, { recursive: true });
  for (const entry of readdirSync(projectCodeDir)) {
    if (entry !== name) rmSync(path.join(projectCodeDir, entry), { recursive: true, force: true });
  }
  if (existsSync(target)) return target;
  const partial = `${target}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  try {
    await copyTree({ git, repo, commit, target: partial, maxBytes, maxEntries: MAX_CODE_FILES });
    renameSync(partial, target);
    return target;
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
}

function shortOf(commit: string | null): string {
  return commit === null ? "?" : commit.slice(0, 8);
}

/**
 * Where the dream reads the project's code: an export of the newest default-branch commit the
 * repository has, or the checkout. Never throws.
 */
export async function codeSource(input: { checkout: string; projectCodeDir: string; maxBytes?: number }): Promise<CodeSource> {
  const git = gitIn(input.checkout);
  const fallback = (note: string, extra: Partial<CodeSource> = {}): CodeSource => ({
    dir: input.checkout,
    kind: "checkout",
    branch: null,
    ref: null,
    commit: null,
    committedAt: null,
    checkoutCommit: null,
    checkoutCommittedAt: null,
    note,
    ...extra,
  });
  try {
    if ((await line(git, ["rev-parse", "--is-inside-work-tree"])) !== "true") return fallback("the checkout is not a git repository");
    const head = await commitOf(git, "HEAD");
    const branch = await defaultBranch(git);
    if (branch === null) return fallback("no default branch (origin/HEAD, main or master) was found", { commit: head, committedAt: head ? await commitTime(git, head) : null });
    const found = await candidates(git, branch);
    if (found.length === 0) return fallback(`the default branch ${branch} has no commit`, { branch });
    const best = await newest(git, found);
    const committedAt = await commitTime(git, best.commit);
    const facts = { branch, ref: best.ref, commit: best.commit, committedAt };
    if (head === best.commit) return { dir: input.checkout, kind: "checkout", ...facts, checkoutCommit: null, checkoutCommittedAt: null, note: null };
    const checkoutFacts = { checkoutCommit: head, checkoutCommittedAt: head ? await commitTime(git, head) : null };
    // The repository's top folder holds the tree; the checkout may be a subfolder of it.
    const top = await line(git, ["rev-parse", "--show-toplevel"]);
    if (top === null) return fallback("its repository's top folder could not be found", { ...facts, ...checkoutFacts });
    let exported: string;
    try {
      exported = await exportCommit(gitIn(top), top, input.projectCodeDir, best.commit, input.maxBytes ?? MAX_CODE_BYTES);
    } catch (error) {
      if (!(error instanceof TreeTooLargeError)) throw error;
      return fallback(`${best.ref} (${shortOf(best.commit)}) is too large to copy (${error.message}), and the checkout is at ${shortOf(head)}`, { ...facts, ...checkoutFacts });
    }
    // A checkout below the repository's top folder reads the same folder in the copy.
    const prefix = (await line(git, ["rev-parse", "--show-prefix"])) ?? "";
    const dir = prefix === "" ? exported : path.join(exported, ...prefix.split("/").filter(Boolean));
    if (!existsSync(dir)) return fallback(`${prefix} is not on ${best.ref}`, { ...facts, ...checkoutFacts });
    return { dir, kind: "copy", ...facts, ...checkoutFacts, note: null };
  } catch (error) {
    return fallback(`its code could not be copied (${error instanceof Error ? error.message : String(error)})`);
  }
}
