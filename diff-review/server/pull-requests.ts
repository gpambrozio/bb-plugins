/**
 * Reviewing a GitHub pull request (the `pr` view), read only:
 *
 * - Its head and base branch are fetched on the workspace's machine into the plugin's own refs (the
 *   host entry's `fetchPull`), and diffed `base...head` there; the user's checkout is never switched or
 *   stashed (decision 6 of the plan).
 * - Its review threads are mirrored into the view's session, by GitHub id, on every load; a reply,
 *   resolve or reopen on one goes to GitHub, then the mirror is read again.
 * - The user's own comments in the view are submitted as one review, with a verdict, only from the
 *   tab's explicit Submit (decision 5: as the owner, through `gh`, never from an agent run). Line
 *   comments become review threads, whole-file and whole-diff ones the review's body; one that cannot
 *   be posted says why. Adapted from diffity's `src-tauri/src/github/review.rs` and `service.rs`
 *   (https://github.com/nilbuild/diffity, MIT).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { placeThread } from "../shared/anchors";
import { parsePullUrl, pullUrl, type PullDetails, type PullRef, type ReviewEvent } from "../shared/github";
import { linesText, parsePatchLines } from "../shared/patch-lines";
import { GENERAL_PATH, type DiffFile, type ReviewThread, type Side } from "../shared/types";
import { loadDiff, ReviewUnavailable, type DiffSources, type LoadedDiff } from "./diff";
import { GitHubError, type DraftThread, type GitHub, type RemoteThread } from "./github";
import type { HostFetchPull } from "./host-git";
import type { GithubThreadInput, ReviewStore } from "./store";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

export const PR_STATUS_PLUGIN_ID = "bb--github-pr-status";

interface Loaded {
  pullId: string;
  headSha: string;
  baseSha: string;
  files: readonly DiffFile[];
}

/** Why a comment cannot go into the review, as the submit dialog lists it. */
export const BLOCKED = {
  notInPull: "Its file is not in the pull request's diff.",
  outdated: "Its lines are no longer in the pull request's diff.",
  empty: "It has no comment.",
} as const;

export interface ReviewPlan {
  /** Line comments, each a review thread on GitHub. */
  lines: { reviewThreadId: string; draft: DraftThread }[];
  /** Whole-diff and whole-file comments, which go into the review's body. */
  body: { reviewThreadId: string; text: string }[];
  blocked: { reviewThreadId: string; reason: string }[];
}

function firstBody(thread: ReviewThread): string | null {
  const first = thread.comments[0];
  return first === undefined || first.body.trim() === "" ? null : first.body;
}

/** The user's own open comment threads of a `pr` view, as one review (diffity's `build_review_plan`). */
export function reviewPlan(threads: readonly ReviewThread[], files: readonly DiffFile[], chosen?: ReadonlySet<string>): ReviewPlan {
  const plan: ReviewPlan = { lines: [], body: [], blocked: [] };
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const thread of threads) {
    if (thread.githubThreadId !== null || thread.status !== "open" || thread.comments[0]?.authorType !== "user") continue;
    if (chosen !== undefined && !chosen.has(thread.id)) continue;
    const body = firstBody(thread);
    if (body === null) {
      plan.blocked.push({ reviewThreadId: thread.id, reason: BLOCKED.empty });
      continue;
    }
    if (thread.filePath === GENERAL_PATH) {
      plan.body.push({ reviewThreadId: thread.id, text: body });
      continue;
    }
    const file = byPath.get(thread.filePath);
    if (file === undefined) {
      plan.blocked.push({ reviewThreadId: thread.id, reason: BLOCKED.notInPull });
      continue;
    }
    if (thread.startLine === 0 || thread.side === null) {
      plan.body.push({ reviewThreadId: thread.id, text: `\`${thread.filePath}\`: ${body}` });
      continue;
    }
    const placement = file.patch === null ? { state: "outdated" as const } : placeThread(thread, parsePatchLines(file.patch));
    if (placement.state === "outdated") {
      plan.blocked.push({ reviewThreadId: thread.id, reason: BLOCKED.outdated });
      continue;
    }
    const side = thread.side === "old" ? "LEFT" : "RIGHT";
    const multi = placement.startLine < placement.endLine;
    plan.lines.push({
      reviewThreadId: thread.id,
      draft: { path: thread.filePath, body, line: placement.endLine, side, ...(multi ? { startLine: placement.startLine, startSide: side } : {}) },
    });
  }
  return plan;
}

/** The review's body: the user's own words, then the whole-diff and whole-file comments. */
export function reviewBody(text: string, sections: readonly string[]): string {
  return [text.trim(), ...sections.map((section) => section.trim())].filter((part) => part !== "").join("\n\n");
}

/** A GitHub review thread as the view mirrors it, its lines' text read from the pull request's diff. */
export function mirrorThread(remote: RemoteThread, files: readonly DiffFile[]): GithubThreadInput | null {
  const line = remote.line ?? remote.originalLine;
  if (line === null) return null;
  const startLine = remote.startLine ?? remote.originalStartLine ?? line;
  const side: Side = remote.diffSide === "LEFT" ? "old" : "new";
  const patch = files.find((file) => file.path === remote.path)?.patch ?? null;
  const anchorContent = patch === null ? null : linesText(parsePatchLines(patch), side, Math.min(startLine, line), line);
  return {
    githubThreadId: remote.id,
    filePath: remote.path,
    side,
    startLine: Math.min(startLine, line),
    endLine: line,
    status: remote.isResolved ? "resolved" : "open",
    anchorContent,
    comments: remote.comments.map((comment) => ({ githubCommentId: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt })),
  };
}

const prStatusSchema = z.record(
  z.string(),
  z.object({ outcome: z.string(), pullRequest: z.object({ url: z.string(), title: z.string() }).passthrough().optional() }).passthrough(),
);

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PullRequests {
  /** What each `pr` session last loaded: the pull request's node id, the commits and files shown. */
  private readonly loaded = new Map<string, Loaded>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly github: GitHub,
    private readonly fetchPull: HostFetchPull,
    private readonly sources: DiffSources,
    private readonly publish: (sessionId: string) => void,
  ) {}

  /** The pull request of a workspace's branch, from bb's GitHub PR Status plugin; null when it has none or cannot say. */
  async branchPull(environmentId: string): Promise<(PullRef & { title: string }) | null> {
    try {
      const rows = await this.bb.sdk.plugins.callRpc({ pluginId: PR_STATUS_PLUGIN_ID, method: "pullRequests", input: { keys: [environmentId] }, outputSchema: prStatusSchema });
      const row = rows[environmentId];
      if (row?.outcome !== "available" || row.pullRequest === undefined) return null;
      const ref = parsePullUrl(row.pullRequest.url);
      return ref === null ? null : { ...ref, title: row.pullRequest.title };
    } catch {
      return null;
    }
  }

  /** The pull request's diff, fetched and computed on the workspace's machine. */
  async load(environment: Environment, ref: PullRef, patterns: readonly string[], ignoreWhitespace: boolean): Promise<{ diff: LoadedDiff; details: Omit<PullDetails, "syncedAt" | "syncError">; pullId: string }> {
    if (environment.path === null) throw new ReviewUnavailable("This workspace has no checkout to fetch the pull request into.");
    let meta;
    try {
      meta = await this.github.pull(ref);
    } catch (error) {
      throw new ReviewUnavailable(`Could not read the pull request from GitHub: ${failure(error)}`);
    }
    let fetched;
    try {
      fetched = await this.fetchPull(environment.hostId, { root: environment.path, url: `https://github.com/${ref.owner}/${ref.repo}.git`, number: ref.number, baseRef: meta.baseRefName });
    } catch (error) {
      throw new ReviewUnavailable(`Could not fetch the pull request on the workspace's machine: ${failure(error)}`);
    }
    const diff = await loadDiff(this.sources, this.bb.log, environment, { kind: "range", from: fetched.baseSha, to: fetched.headSha, symmetric: true }, patterns, ignoreWhitespace);
    return {
      diff: { ...diff, viewable: false },
      pullId: meta.id,
      details: { number: meta.number, title: meta.title, url: meta.url, state: meta.state, baseRefName: meta.baseRefName, headRefName: meta.headRefName, headSha: fetched.headSha, baseSha: fetched.baseSha },
    };
  }

  /** Mirrors the pull request's review threads into the session; the error, when GitHub cannot be read. */
  async sync(sessionId: string, ref: PullRef, loaded?: Loaded): Promise<{ syncedAt: number | null; syncError: string | null }> {
    if (loaded !== undefined) this.loaded.set(sessionId, loaded);
    const files = this.loaded.get(sessionId)?.files ?? [];
    try {
      const remote = await this.github.threads(ref);
      const mirrored = remote.map((thread) => mirrorThread(thread, files)).filter((thread) => thread !== null);
      if (this.store.syncGithubThreads(sessionId, mirrored)) this.publish(sessionId);
      return { syncedAt: Date.now(), syncError: null };
    } catch (error) {
      this.bb.log.warn(`Could not read the review threads of ${pullUrl(ref)}: ${failure(error)}`);
      return { syncedAt: null, syncError: failure(error) };
    }
  }

  /** A reply on a mirrored thread, posted to GitHub as the owner, then read back. */
  async reply(thread: ReviewThread, ref: PullRef, body: string): Promise<void> {
    await this.github.reply(thread.githubThreadId!, body);
    await this.sync(thread.sessionId, ref);
  }

  /** Resolves or reopens a mirrored thread on GitHub, then reads it back. */
  async setResolved(thread: ReviewThread, ref: PullRef, resolved: boolean): Promise<void> {
    await this.github.setResolved(thread.githubThreadId!, resolved);
    await this.sync(thread.sessionId, ref);
  }

  /**
   * Submits the user's chosen comments as one review with the verdict. The pull request must still be
   * at the commit the view showed; the comments that went into it are removed from the view, since
   * GitHub's copies come back with the next read.
   */
  /** The plan for the session's comments, against the diff last loaded; null before a load. */
  plan(sessionId: string): ReviewPlan | null {
    const loaded = this.loaded.get(sessionId);
    return loaded === undefined ? null : reviewPlan(this.store.threads(sessionId), loaded.files);
  }

  async submit(input: { sessionId: string; ref: PullRef; event: ReviewEvent; body: string; headSha: string; reviewThreadIds: readonly string[] }): Promise<{ url: string | null; posted: number; blocked: ReviewPlan["blocked"] }> {
    const loaded = this.loaded.get(input.sessionId);
    if (loaded === undefined) throw new GitHubError("Load the pull request's view first.");
    let meta;
    try {
      meta = await this.github.pull(input.ref);
    } catch (error) {
      throw new GitHubError(`Could not read the pull request from GitHub: ${failure(error)}`);
    }
    if (meta.headRefOid !== input.headSha || loaded.headSha !== input.headSha) {
      throw new GitHubError("The pull request has new commits since this view loaded; reload it, check your comments, and submit again.");
    }
    const plan = reviewPlan(this.store.threads(input.sessionId), loaded.files, new Set(input.reviewThreadIds));
    const body = reviewBody(input.body, plan.body.map((entry) => entry.text));
    if (input.event === "REQUEST_CHANGES" && body === "" && plan.lines.length === 0) throw new GitHubError("Requesting changes needs a comment or a review body.");
    const result = await this.github.submitReview(meta.id, input.headSha, input.event, body, plan.lines.map((entry) => entry.draft));
    const posted = [...plan.lines.map((entry) => entry.reviewThreadId), ...plan.body.map((entry) => entry.reviewThreadId)];
    this.store.deleteThreads(posted);
    await this.sync(input.sessionId, input.ref);
    this.publish(input.sessionId);
    return { url: result.url, posted: posted.length, blocked: plan.blocked };
  }
}
