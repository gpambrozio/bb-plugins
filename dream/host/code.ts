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
 *   `merge-base`, `ls-tree`, `archive`), with `GIT_OPTIONAL_LOCKS=0` so none refreshes the index.
 *   When the checkout's HEAD is already that commit, the dream reads the checkout itself. Otherwise
 *   `git archive` exports the commit's tree into `<code root>/<project>/<commit>/`, a folder outside
 *   the repository and bb's data folder; the export is reused while the commit stays the newest, and
 *   older exports of the project are removed.
 * - **Anything unexpected falls back to the checkout**, with a note the prompt passes on: not a git
 *   repository, no default branch, a tree over `MAX_CODE_BYTES`, or a failing command. Never fails a
 *   dream.
 *
 * Submodules are not in an export (`git archive` leaves them out), and neither are untracked files.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import type { CodeSource } from "../shared/types";

export type { CodeSource };

/** A tree larger than this is not exported; the dream reads the checkout. */
export const MAX_CODE_BYTES = 1024 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 300_000;
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

async function treeBytes(git: Git, commit: string): Promise<number> {
  const result = await git(["ls-tree", "-r", "-l", "-z", commit], { timeoutMs: EXPORT_TIMEOUT_MS });
  if (result.code !== 0) throw new Error("git ls-tree failed");
  let total = 0;
  for (const entry of result.stdout.split("\0")) {
    const size = /^\S+ blob \S+\s+(\d+)\t/.exec(entry);
    if (size) total += Number(size[1]);
  }
  return total;
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXPORT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

/** Exports `commit` into `<projectCodeDir>/<commit>/`, reusing a finished export, and removes older ones. */
async function exportCommit(git: Git, projectCodeDir: string, commit: string): Promise<string> {
  const target = path.join(projectCodeDir, commit);
  mkdirSync(projectCodeDir, { recursive: true });
  for (const name of readdirSync(projectCodeDir)) {
    if (name !== commit) rmSync(path.join(projectCodeDir, name), { recursive: true, force: true });
  }
  if (existsSync(target)) return target;
  const partial = `${target}.partial-${process.pid}`;
  const archive = `${partial}.tar`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial);
  try {
    const result = await git(["archive", "--format=tar", `--output=${archive}`, commit], { timeoutMs: EXPORT_TIMEOUT_MS });
    if (result.code !== 0) throw new Error("git archive failed");
    await run("tar", ["-xf", archive, "-C", partial]);
    renameSync(partial, target);
    return target;
  } finally {
    rmSync(archive, { force: true });
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
    // From the repository's top folder: run in a subfolder, `ls-tree` and `archive` see only that.
    const top = await line(git, ["rev-parse", "--show-toplevel"]);
    if (top === null) return fallback("its repository's top folder could not be found", { ...facts, ...checkoutFacts });
    const topGit = gitIn(top);
    const bytes = await treeBytes(topGit, best.commit);
    const limit = input.maxBytes ?? MAX_CODE_BYTES;
    if (bytes > limit) {
      return fallback(`${best.ref} (${shortOf(best.commit)}) is too large to copy (${Math.round(bytes / 1048576)} MB), and the checkout is at ${shortOf(head)}`, { ...facts, ...checkoutFacts });
    }
    const exported = await exportCommit(topGit, input.projectCodeDir, best.commit);
    // A checkout below the repository's top folder reads the same folder in the copy.
    const prefix = (await line(git, ["rev-parse", "--show-prefix"])) ?? "";
    const dir = prefix === "" ? exported : path.join(exported, ...prefix.split("/").filter(Boolean));
    if (!existsSync(dir)) return fallback(`${prefix} is not on ${best.ref}`, { ...facts, ...checkoutFacts });
    return { dir, kind: "copy", ...facts, ...checkoutFacts, note: null };
  } catch (error) {
    return fallback(`its code could not be copied (${error instanceof Error ? error.message : String(error)})`);
  }
}
