/**
 * The diff under review, from bb's own environment APIs (`bb.sdk.environments.*`). Those run git on
 * the machine that holds the workspace, remote hosts included, so nothing here needs a host entry. What
 * they cannot give — staged against unstaged, arbitrary ranges — is phase 4's.
 */
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { Commit, DiffFile, Target, TargetRequest } from "../shared/types";
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
export async function workspaceRefs(sdk: Sdk, log: BbPluginApi["log"], environment: Environment, base: string | undefined): Promise<WorkspaceRefs> {
  const fallback = { defaultBase: environment.mergeBaseBranch ?? environment.defaultBranch, currentBranch: environment.branchName, commits: [] };
  let status: Awaited<ReturnType<Sdk["environments"]["status"]>>;
  try {
    status = await sdk.environments.status({
      environmentId: environment.id,
      ...(base === undefined ? {} : { mergeBaseBranch: base }),
    });
  } catch (error) {
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
export async function uncommittedFingerprint(sdk: Sdk, environmentId: string): Promise<{ prints: Fingerprint; complete: boolean }> {
  const result = await sdk.environments.diffFiles({ environmentId, target: "uncommitted" });
  if (result.outcome !== "available") return { prints: {}, complete: false };
  const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch.patch]));
  const missing = result.files.filter((file) => !patches.has(file.path) && !file.binary && file.loadMode !== "too_large").map((file) => file.path);
  let complete = missing.length <= FINGERPRINT_MAX_FILES;
  for (let index = 0; index < Math.min(missing.length, FINGERPRINT_MAX_FILES); index += 50) {
    const batch = await sdk.environments.diffPatch({ environmentId, paths: missing.slice(index, index + 50), target: { type: "uncommitted" } });
    if (batch.outcome === "available") for (const patch of batch.patches) patches.set(patch.path, patch.patch);
    else complete = false;
  }
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

export async function workspaceState(sdk: Sdk, environmentId: string): Promise<WorkspaceState> {
  const [status, uncommitted] = await Promise.all([sdk.environments.status({ environmentId }), uncommittedFingerprint(sdk, environmentId)]);
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
  if (request.kind === "uncommitted" || request.kind === "commit") return request;
  const base = request.base ?? defaultBase;
  if (base === null) throw new ReviewUnavailable("This workspace has no base branch to compare against; pick one.");
  return { kind: request.kind, base };
}

function diffQuery(target: Target) {
  switch (target.kind) {
    case "uncommitted":
      return { target: "uncommitted" as const };
    case "branch":
      return { target: "branch_committed" as const, mergeBaseBranch: target.base };
    case "all":
      return { target: "all" as const, mergeBaseBranch: target.base };
    case "commit":
      return { target: "commit" as const, sha: target.sha };
  }
}

function patchTarget(target: Target) {
  switch (target.kind) {
    case "uncommitted":
      return { type: "uncommitted" as const };
    case "branch":
      return { type: "branch_committed" as const, mergeBaseBranch: target.base };
    case "all":
      return { type: "all" as const, mergeBaseBranch: target.base };
    case "commit":
      return { type: "commit" as const, sha: target.sha };
  }
}

function failureMessage(result: { outcome: "not_applicable"; message: string } | { outcome: "unavailable"; failure: { message: string } }): string {
  return result.outcome === "not_applicable" ? result.message : result.failure.message;
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
}

/** The changed files of a view with the patches bb sends up front, minus the ignored ones. */
export async function loadDiff(sdk: Sdk, environment: Environment, target: Target, patterns: readonly string[]): Promise<LoadedDiff> {
  const result = await sdk.environments.diffFiles({ environmentId: environment.id, ...diffQuery(target) });
  if (result.outcome !== "available") throw new ReviewUnavailable(failureMessage(result));
  const ignored = ignoreMatcher(patterns);
  const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch]));
  const files: DiffFile[] = [];
  const ignoredPaths: string[] = [];
  for (const file of result.files) {
    if (ignored(file.path)) {
      ignoredPaths.push(file.path);
      continue;
    }
    const patch = patches.get(file.path);
    files.push({
      path: file.path,
      previousPath: file.previousPath,
      changeKind: file.changeKind,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      loadMode: file.loadMode,
      untracked: file.origin === "untracked",
      patch: patch?.patch ?? null,
      patchTruncated: patch?.truncated ?? false,
    });
  }
  return { files, ignoredPaths, truncated: result.truncated };
}

/** Patches for files bb left to load on demand. */
export async function loadPatches(
  sdk: Sdk,
  environment: Environment,
  target: Target,
  paths: readonly string[],
): Promise<{ path: string; patch: string; truncated: boolean }[]> {
  const result = await sdk.environments.diffPatch({ environmentId: environment.id, paths: [...paths], target: patchTarget(target) });
  if (result.outcome !== "available") throw new ReviewUnavailable(failureMessage(result));
  return result.patches;
}
