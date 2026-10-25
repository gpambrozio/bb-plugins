/**
 * The diff under review, from bb's own environment APIs (`bb.sdk.environments.*`). Those run git on
 * the machine that holds the workspace, remote hosts included, so nothing here needs a host entry. What
 * they cannot give — staged against unstaged, arbitrary ranges — is phase 4's.
 */
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { Commit, DiffFile, Target, TargetRequest } from "../shared/types";
import { IGNORE_FILES, ignoreMatcher, patternLines } from "./ignore";

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
  for (const name of IGNORE_FILES) {
    try {
      const file = await sdk.files.read({ hostId: environment.hostId, path: posix.join(environment.path, name) });
      const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      patterns.push(...patternLines(text));
    } catch (error) {
      log.debug(`No ${name} read in ${environment.id}: ${error instanceof Error ? error.message : String(error)}`);
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
