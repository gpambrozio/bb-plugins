/**
 * The diff under review, from bb's Git plugin (`server/git.ts`), which runs git on the machine that
 * holds the workspace, remote hosts included, so nothing here needs a host entry.
 */
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { HostDiffSpec } from "../shared/git-spec";
import { isHostTarget, type Commit, type DiffFile, type HostTarget, type Target, type TargetRequest, type Viewed } from "../shared/types";
import type { HostGit } from "./host-git";
import { failureMessage, type GitReads, type GitStatus, type GitTarget } from "./git";
import { gitfileTarget, ignoreMatcher, INFO_IGNORE_FILE, patternLines, WORKSPACE_IGNORE_FILE } from "./ignore";

type Sdk = BbPluginApi["sdk"];
type Environment = Awaited<ReturnType<Sdk["environments"]["get"]>>;

export class ReviewUnavailable extends Error {}

/** The workspace a thread runs in, or why it has none to review. */
export async function workspaceOf(sdk: Sdk, threadId: string): Promise<Environment> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) throw new ReviewUnavailable("This thread has no workspace yet, so there is no diff to review.");
  const environment = await sdk.environments.get({ environmentId: thread.environmentId });
  if (environment.status === "destroyed" || environment.path === null) {
    throw new ReviewUnavailable("This thread's workspace is gone (the thread was archived), so there is no diff to review.");
  }
  if (!environment.isGitRepo) throw new ReviewUnavailable("This thread's workspace is not a git repository.");
  return environment;
}

export interface WorkspaceRefs {
  defaultBase: string | null;
  currentBranch: string | null;
  commits: Commit[];
}

/**
 * The branch the branch views compare against, the current branch, and its commits since the base.
 * The diff does not depend on them, so when bb cannot give a status the environment's own record
 * stands in, without the commit list, and the reason is logged.
 */
export async function workspaceRefs(git: GitReads, log: BbPluginApi["log"], environment: Environment, base: string | undefined): Promise<WorkspaceRefs> {
  const fallback = { defaultBase: environment.mergeBaseBranch ?? environment.defaultBranch, currentBranch: environment.branchName, commits: [] };
  let status: GitStatus;
  try {
    status = await git.status(environment.id, base);
  } catch (error) {
    if (error instanceof ReviewUnavailable) throw error;
    log.warn(`No git status for ${environment.id}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
  if (status.outcome !== "available") return fallback;
  const { branch, mergeBase } = status.workspace;
  return {
    defaultBase: environment.mergeBaseBranch ?? mergeBase?.mergeBaseBranch ?? branch.defaultBranch,
    currentBranch: branch.currentBranch,
    commits: (mergeBase?.commits ?? []).map((commit) => ({ sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject })),
  };
}

/** The most files whose on-demand patches a fingerprint fetches one by one. */
export const FINGERPRINT_MAX_FILES = 500;

/** Path → a fingerprint of its uncommitted change. */
export type Fingerprint = Record<string, string>;

/**
 * Each uncommitted file's change kind, line counts and patch hash. bb sends some patches up front and
 * leaves the rest to load on demand; those are fetched too (in batches, up to `FINGERPRINT_MAX_FILES`),
 * since an edit can keep a file's line counts. `complete` is false when a patch could not be had for a
 * file that has one to show (past the limit, or bb did not answer), so equality is not proof there.
 * Binary and too-large files show no patch, so their counts are all there is to compare.
 */
export async function uncommittedFingerprint(git: GitReads, environmentId: string): Promise<{ prints: Fingerprint; complete: boolean }> {
  const target: GitTarget = { type: "uncommitted" };
  const result = await git.files(environmentId, target, false);
  if (result.outcome !== "available") return { prints: {}, complete: false };
  const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch.patch]));
  const missing = result.files.filter((file) => !patches.has(file.path) && !file.binary && file.loadMode !== "too_large");
  let complete = missing.length <= FINGERPRINT_MAX_FILES;
  const fetched = await git.patches(environmentId, target, false, missing.slice(0, FINGERPRINT_MAX_FILES));
  for (const patch of fetched.patches) patches.set(patch.path, patch.patch);
  if (fetched.failure !== null) complete = false;
  const prints: Fingerprint = {};
  for (const file of result.files) {
    const patch = patches.get(file.path);
    if (patch === undefined && !file.binary && file.loadMode !== "too_large") complete = false;
    prints[file.path] = `${file.previousPath ?? ""}:${file.changeKind}:${file.additions}:${file.deletions}:${patch === undefined ? "" : createHash("sha256").update(patch).digest("hex")}`;
  }
  return { prints, complete };
}

/**
 * The state of a workspace's diffs: its checkout (HEAD), how it stands against its base, and its
 * uncommitted changes (`uncommittedFingerprint`: every file's kind, line counts and patch content,
 * on-demand patches included). Two equal keys mean no view of the workspace changed. When a patch
 * could not be compared, the key is new every time, so the tabs reload rather than show a stale
 * diff. Only the named fields count: anything else bb's answers carry (now or in a later bb) must not
 * make an unchanged workspace look changed. `summary` says the same in words, for the log.
 */
export interface WorkspaceState {
  key: string;
  summary: string;
}

export async function workspaceState(git: GitReads, environmentId: string): Promise<WorkspaceState> {
  const [status, uncommitted] = await Promise.all([git.status(environmentId), uncommittedFingerprint(git, environmentId)]);
  const parts: string[] = [];
  if (status.outcome === "available") {
    const { checkout, mergeBase } = status.workspace;
    const head = checkout.kind === "branch" || checkout.kind === "detached" ? (checkout.headSha ?? "none") : checkout.kind;
    parts.push(`head ${head}`);
    parts.push(mergeBase === null || mergeBase === undefined ? "no base" : `base ${mergeBase.baseRef} +${mergeBase.aheadCount}/-${mergeBase.behindCount}`);
  } else parts.push(`status ${status.outcome}`);
  const hash = createHash("sha256");
  const paths = Object.keys(uncommitted.prints).sort();
  for (const path of paths) hash.update(`\n${path}\0${uncommitted.prints[path]}`);
  parts.push(`${paths.length} uncommitted file(s) ${hash.digest("hex").slice(0, 12)}`);
  if (!uncommitted.complete) parts.push(`not all compared (${randomUUID().slice(0, 8)})`);
  const summary = parts.join(", ");
  return { key: createHash("sha256").update(summary).digest("hex"), summary };
}

/** Fills in the base a branch view left out. */
export function resolveTarget(request: TargetRequest, defaultBase: string | null): Target {
  if (request.kind !== "branch" && request.kind !== "all") return request;
  const base = request.base ?? defaultBase;
  if (base === null) throw new ReviewUnavailable("This workspace has no base branch to compare against; pick one.");
  return { kind: request.kind, base };
}

/** A view as the Git plugin names it; the host entry's views (staged, unstaged, range) have none. */
export function gitTarget(target: Target): GitTarget {
  switch (target.kind) {
    case "staged":
    case "unstaged":
    case "range":
    case "files":
      throw new ReviewUnavailable(`bb's Git plugin has no ${target.kind} view.`);
    case "uncommitted":
      return { type: "uncommitted" };
    case "branch":
      return { type: "branch_committed", mergeBaseBranch: target.base };
    case "all":
      return { type: "all", mergeBaseBranch: target.base };
    case "commit":
      return { type: "commit", sha: target.sha };
  }
}

async function readText(sdk: Sdk, hostId: string, path: string): Promise<string> {
  const file = await sdk.files.read({ hostId, path });
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}

async function readTextOrNull(sdk: Sdk, hostId: string, path: string): Promise<string | null> {
  try {
    return await readText(sdk, hostId, path);
  } catch {
    return null;
  }
}

/**
 * The directory whose `info/` holds the repository's ignore file, as `git rev-parse --git-path
 * info/diffityignore` finds it, read through bb rather than by running git, so it works on any host.
 * In a plain checkout that is `.git`. In a linked worktree `.git` is a file naming the worktree's
 * git dir, and `info/` is shared: it lives in the common dir that git dir's `commondir` names. A
 * submodule's gitfile has no `commondir`, so its git dir is the one.
 */
export async function gitInfoParent(sdk: Sdk, hostId: string, root: string): Promise<string> {
  const dotGit = posix.join(root, ".git");
  // A directory cannot be read as a file: that is a plain checkout.
  const gitfile = await readTextOrNull(sdk, hostId, dotGit);
  const target = gitfile === null ? null : gitfileTarget(gitfile);
  if (target === null) return dotGit;
  const gitDir = posix.resolve(root, target);
  const common = (await readTextOrNull(sdk, hostId, posix.join(gitDir, "commondir")))?.trim() ?? "";
  return common === "" ? gitDir : posix.resolve(gitDir, common);
}

/**
 * The ignore patterns for a workspace: the setting's, then the workspace's diffity ignore files when
 * `readIgnoreFiles` is on. A file that cannot be read counts as absent — the usual case is that it
 * does not exist — and the reason is logged at debug level.
 */
export async function ignorePatterns(
  sdk: Sdk,
  log: BbPluginApi["log"],
  environment: Environment,
  setting: string,
  readIgnoreFiles: boolean,
): Promise<string[]> {
  const patterns = patternLines(setting);
  if (!readIgnoreFiles || environment.path === null) return patterns;
  const paths = [posix.join(environment.path, WORKSPACE_IGNORE_FILE), posix.join(await gitInfoParent(sdk, environment.hostId, environment.path), INFO_IGNORE_FILE)];
  for (const path of paths) {
    try {
      patterns.push(...patternLines(await readText(sdk, environment.hostId, path)));
    } catch (error) {
      log.debug(`No ${path} read in ${environment.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return patterns;
}

export interface LoadedDiff {
  files: DiffFile[];
  ignoredPaths: string[];
  truncated: boolean;
  /** The commit a branch view compares against, which a file's old side is read at. */
  mergeBaseRef: string | null;
  /** The commit a range view's new side is. */
  headRef: string | null;
  /** Whether the view takes bb's Viewed marks. */
  viewable: boolean;
}

/** Where the diff of a view comes from: bb's Git plugin, or the plugin's host entry for the views only raw git gives. */
export interface DiffSources {
  git: GitReads;
  host: HostGit;
}

/**
 * Whether a file is marked Viewed: `yes` at its current revision, `changed` when it was marked at an
 * earlier one (bb's own diff panel then shows it unmarked), `no` otherwise.
 */
export function viewedState(revision: string, marked: string | undefined): Viewed {
  if (marked === undefined) return "no";
  return marked === revision ? "yes" : "changed";
}

/**
 * The changed files of a view with the patches bb sends up front, minus the ignored ones, and each
 * file's Viewed mark. Marks are bb's own (shared with its diff panel); when they cannot be read the
 * files show unmarked and the reason is logged.
 */
export async function loadDiff(
  sources: DiffSources,
  log: BbPluginApi["log"],
  environment: Environment,
  target: Target,
  patterns: readonly string[],
  ignoreWhitespace = false,
): Promise<LoadedDiff> {
  if (isHostTarget(target)) return loadHostDiff(sources.host, environment, target, patterns, ignoreWhitespace);
  const git = sources.git;
  const result = await git.files(environment.id, gitTarget(target), ignoreWhitespace);
  if (result.outcome !== "available") throw new ReviewUnavailable(failureMessage(result));
  const ignored = ignoreMatcher(patterns);
  const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch]));
  const shown = result.files.filter((file) => !ignored(file.path));
  let marks = new Map<string, string>();
  try {
    if (shown.length > 0) marks = await git.viewed(environment.id, gitTarget(target), shown.map((file) => file.path));
  } catch (error) {
    if (error instanceof ReviewUnavailable) throw error;
    log.warn(`No Viewed marks for ${environment.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: DiffFile[] = shown.map((file) => {
    const patch = patches.get(file.path);
    return {
      path: file.path,
      previousPath: file.previousPath,
      changeKind: file.changeKind,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      loadMode: file.loadMode,
      untracked: file.origin === "untracked",
      revision: file.revision,
      viewed: viewedState(file.revision, marks.get(file.path)),
      patch: patch?.patch ?? null,
      patchTruncated: patch?.truncated ?? false,
    };
  });
  const ignoredPaths = result.files.filter((file) => ignored(file.path)).map((file) => file.path);
  return { files, ignoredPaths, truncated: result.truncated, mergeBaseRef: result.mergeBaseRef, headRef: null, viewable: true };
}

/**
 * A staged, unstaged or range view, from git on the workspace's host. Every patch comes with the list
 * (none loads on demand); a file's revision is its patch's hash, so it still tells a comment's file
 * changed. bb's Viewed marks do not cover these views.
 */
async function loadHostDiff(host: HostGit, environment: Environment, target: HostTarget, patterns: readonly string[], ignoreWhitespace: boolean): Promise<LoadedDiff> {
  if (environment.path === null) throw new ReviewUnavailable("This workspace has no checkout.");
  const spec: HostDiffSpec = target.kind === "range" ? { kind: "range", from: target.from, to: target.to, symmetric: target.symmetric } : { kind: target.kind };
  let result;
  try {
    result = await host(environment.hostId, environment.path, spec, ignoreWhitespace);
  } catch (error) {
    throw new ReviewUnavailable(`Could not read the ${target.kind} view on the workspace's machine: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ignored = ignoreMatcher(patterns);
  const files: DiffFile[] = result.files
    .filter((file) => !ignored(file.path))
    .map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      changeKind: file.changeKind,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      loadMode: file.tooLarge ? "too_large" : "auto",
      untracked: file.untracked,
      revision: `h:${createHash("sha256").update(file.patch ?? `${file.changeKind}:${file.additions}:${file.deletions}`).digest("hex").slice(0, 24)}`,
      viewed: "no",
      patch: file.patch,
      patchTruncated: false,
    }));
  const ignoredPaths = result.files.filter((file) => ignored(file.path)).map((file) => file.path);
  return { files, ignoredPaths, truncated: result.truncated, mergeBaseRef: result.baseSha, headRef: result.headSha, viewable: false };
}

/** Patches for files bb left to load on demand, at the revisions the file list gave. */
export async function loadPatches(
  git: GitReads,
  environment: Environment,
  target: Target,
  files: readonly { path: string; revision: string }[],
  ignoreWhitespace = false,
): Promise<{ path: string; patch: string; truncated: boolean }[]> {
  // The host entry's views send every patch with the list.
  if (isHostTarget(target) || target.kind === "files") return [];
  const result = await git.patches(environment.id, gitTarget(target), ignoreWhitespace, files);
  if (result.failure !== null && result.patches.length === 0) throw new ReviewUnavailable(result.failure);
  return result.patches;
}
