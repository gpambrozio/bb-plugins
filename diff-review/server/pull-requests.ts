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
import { GENERAL_PATH, type DiffFile, type GithubDraft, type ReviewThread, type Side, type Viewed } from "../shared/types";
import { loadDiff, ReviewUnavailable, type DiffSources, type LoadedDiff } from "./diff";
import { GitHubError, type DraftThread, type FileViewedState, type GitHub, type RemoteThread } from "./github";
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
  /** Line comments, each a review thread on GitHub; `commentId` and `body` are the comment posted. */
  lines: { reviewThreadId: string; commentId: string; body: string; draft: DraftThread }[];
  /** Whole-diff and whole-file comments, which go into the review's body. */
  body: { reviewThreadId: string; commentId: string; body: string; text: string }[];
  blocked: { reviewThreadId: string; reason: string }[];
  /** Agents' drafts on GitHub threads, each a reply in the review; `resolve` ones resolve their thread after it. */
  replies: { reviewThreadId: string; commentId: string; githubThreadId: string; body: string; resolve: boolean }[];
}

function firstBody(thread: ReviewThread): string | null {
  const first = thread.comments[0];
  return first === undefined || first.body.trim() === "" ? null : first.body;
}

/**
 * The user's own open comment threads of a `pr` view, and agents' drafts on its GitHub threads, as one
 * review (diffity's `build_review_plan`). `chosen` limits the threads, `chosenReplies` the drafts (by
 * comment id); each takes everything when left out.
 */
export function reviewPlan(threads: readonly ReviewThread[], files: readonly DiffFile[], chosen?: ReadonlySet<string>, chosenReplies?: ReadonlySet<string>): ReviewPlan {
  const plan: ReviewPlan = { lines: [], body: [], blocked: [], replies: [] };
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const thread of threads) {
    if (thread.githubThreadId !== null) {
      for (const comment of thread.comments) {
        if (comment.githubDraft === undefined || (chosenReplies !== undefined && !chosenReplies.has(comment.id))) continue;
        plan.replies.push({ reviewThreadId: thread.id, commentId: comment.id, githubThreadId: thread.githubThreadId, body: comment.body, resolve: comment.githubDraft === "resolve" });
      }
      continue;
    }
    if (thread.status !== "open" || thread.comments[0]?.authorType !== "user") continue;
    if (chosen !== undefined && !chosen.has(thread.id)) continue;
    const body = firstBody(thread);
    if (body === null) {
      plan.blocked.push({ reviewThreadId: thread.id, reason: BLOCKED.empty });
      continue;
    }
    if (thread.filePath === GENERAL_PATH) {
      plan.body.push({ reviewThreadId: thread.id, commentId: thread.comments[0]!.id, body, text: body });
      continue;
    }
    const file = byPath.get(thread.filePath);
    if (file === undefined) {
      plan.blocked.push({ reviewThreadId: thread.id, reason: BLOCKED.notInPull });
      continue;
    }
    if (thread.startLine === 0 || thread.side === null) {
      plan.body.push({ reviewThreadId: thread.id, commentId: thread.comments[0]!.id, body, text: `\`${thread.filePath}\`: ${body}` });
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
      commentId: thread.comments[0]!.id,
      body,
      draft: { path: thread.filePath, body, line: placement.endLine, side, ...(multi ? { startLine: placement.startLine, startSide: side } : {}) },
    });
  }
  return plan;
}

/** The review's body: the user's own words, then the whole-diff and whole-file comments. */
export function reviewBody(text: string, sections: readonly string[]): string {
  return [text.trim(), ...sections.map((section) => section.trim())].filter((part) => part !== "").join("\n\n");
}

/**
 * The commented lines' text as GitHub saw them: the last lines of the first comment's `diffHunk` on
 * the comment's side (the hunk ends with the lines commented on).
 */
export function hunkAnchor(diffHunk: string | null, side: Side, count: number): string | null {
  if (diffHunk === null || count < 1) return null;
  const lines = diffHunk
    .split("\n")
    .filter((line) => !line.startsWith("@@") && !line.startsWith("\\"))
    .filter((line) => (side === "old" ? !line.startsWith("+") : !line.startsWith("-")))
    .map((line) => line.slice(1));
  if (lines.length < count) return null;
  return lines.slice(lines.length - count).join("\n");
}

/**
 * A GitHub review thread as the view mirrors it. A comment on a whole file (`subjectType` FILE) is a
 * whole-file thread. A thread GitHub marks outdated, or that has no current line, keeps its original
 * lines and the text it was made on (from its `diffHunk`), so it is placed by that text or listed as
 * not on the current diff, never pinned to whatever code sits at its old line number now.
 */
export function mirrorThread(remote: RemoteThread, files: readonly DiffFile[]): GithubThreadInput | null {
  const status = remote.isResolved ? ("resolved" as const) : ("open" as const);
  const comments = remote.comments.map((comment) => ({ githubCommentId: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt }));
  if (remote.subjectType === "FILE") {
    return { githubThreadId: remote.id, filePath: remote.path, side: null, startLine: 0, endLine: 0, status, anchorContent: null, comments };
  }
  const side: Side = remote.diffSide === "LEFT" ? "old" : "new";
  const current = !remote.isOutdated && remote.line !== null;
  const line = current ? remote.line : remote.originalLine;
  if (line === null) return null;
  const rawStart = current ? (remote.startLine ?? line) : (remote.originalStartLine ?? line);
  const startLine = Math.min(rawStart, line);
  let anchorContent: string | null;
  if (current) {
    const patch = files.find((file) => file.path === remote.path)?.patch ?? null;
    anchorContent = patch === null ? null : linesText(parsePatchLines(patch), side, startLine, line);
  } else {
    anchorContent = hunkAnchor(remote.comments[0]?.diffHunk ?? null, side, line - startLine + 1) ?? OUTDATED_ANCHOR;
  }
  return { githubThreadId: remote.id, filePath: remote.path, side, startLine, endLine: line, status, anchorContent, comments };
}

/**
 * The anchor of an outdated thread whose original text GitHub did not give: no line reads it, so the
 * thread is listed as not on the current diff.
 */
export const OUTDATED_ANCHOR = "\u0000diff-review: outdated on GitHub\u0000";

/**
 * A file's Viewed mark on GitHub as the view shows one: GitHub resets a mark to `DISMISSED` when the
 * file changes after it was marked, which is the view's "changed since viewed".
 */
export function githubViewed(state: FileViewedState | undefined): Viewed {
  if (state === "VIEWED") return "yes";
  if (state === "DISMISSED") return "changed";
  return "no";
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
  /**
   * The agents' drafts being posted, by comment id, until the row records GitHub's comment. Post and
   * Submit review each claim theirs (two windows, a slow GitHub), so a draft goes to GitHub once.
   */
  private readonly posting = new Set<string>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly github: GitHub,
    private readonly fetchPull: HostFetchPull,
    private readonly sources: DiffSources,
    private readonly publish: (sessionId: string) => void,
  ) {}

  /**
   * The pull request of a workspace's branch, from bb's GitHub PR Status plugin; null when it has none
   * or cannot say, and when `signal` abandoned the wait (bb 0.48.1's PR Status finishes its lookup anyway).
   */
  async branchPull(environmentId: string, signal?: AbortSignal): Promise<(PullRef & { title: string }) | null> {
    try {
      const rows = await this.bb.sdk.plugins.callRpc({
        pluginId: PR_STATUS_PLUGIN_ID,
        method: "pullRequests",
        input: { keys: [environmentId] },
        outputSchema: prStatusSchema,
        ...(signal === undefined ? {} : { signal }),
      });
      const row = rows[environmentId];
      if (row?.outcome !== "available" || row.pullRequest === undefined) return null;
      const ref = parsePullUrl(row.pullRequest.url);
      return ref === null ? null : { ...ref, title: row.pullRequest.title };
    } catch {
      return null;
    }
  }

  /**
   * The pull request's diff, fetched and computed on the workspace's machine. With `viewed`, each file
   * carries the account's own Viewed mark on GitHub, read beside the fetch; when the marks cannot be
   * read the view takes none (`viewable: false`) and `viewedError` says why. `signal` abandons only that
   * read: the diff is the view, and nothing is written from the marks.
   */
  async load(
    environment: Environment,
    ref: PullRef,
    patterns: readonly string[],
    ignoreWhitespace: boolean,
    options: { viewed?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ diff: LoadedDiff; details: Omit<PullDetails, "syncedAt" | "syncError">; pullId: string }> {
    if (environment.path === null) throw new ReviewUnavailable("This workspace has no checkout to fetch the pull request into.");
    const marks = options.viewed === true ? this.viewedMarks(ref, options.signal) : Promise.resolve({ states: null, error: null });
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
    const { states, error: viewedError } = await marks;
    return {
      diff: { ...diff, files: states === null ? diff.files : diff.files.map((file) => ({ ...file, viewed: githubViewed(states.get(file.path)) })), viewable: states !== null },
      pullId: meta.id,
      details: {
        number: meta.number,
        title: meta.title,
        url: meta.url,
        state: meta.state,
        baseRefName: meta.baseRefName,
        headRefName: meta.headRefName,
        headSha: fetched.headSha,
        baseSha: fetched.baseSha,
        viewedError,
      },
    };
  }

  /** The account's Viewed marks on the pull request's files; never rejects, so a failed read cannot fail the load. */
  private async viewedMarks(ref: PullRef, signal?: AbortSignal): Promise<{ states: Map<string, FileViewedState> | null; error: string | null }> {
    try {
      return { states: await this.github.viewedFiles(ref, signal), error: null };
    } catch (error) {
      if (signal?.aborted !== true) this.bb.log.warn(`Could not read the Viewed marks of ${pullUrl(ref)}: ${failure(error)}`);
      return { states: null, error: failure(error) };
    }
  }

  /**
   * Marks a file Viewed on GitHub for the signed-in account, or clears the mark (only ever from the
   * tab's Viewed box). GitHub keeps one mark per file, which it dismisses itself when the file changes.
   * A file the view's last load did not show is refused.
   */
  async setViewed(sessionId: string, ref: PullRef, path: string, viewed: boolean): Promise<void> {
    const loaded = this.loaded.get(sessionId);
    if (loaded !== undefined && !loaded.files.some((file) => file.path === path)) throw new GitHubError(`${path} is not in the pull request's diff; reload the view.`);
    const pullId = loaded?.pullId ?? (await this.github.pull(ref)).id;
    await this.github.setViewed(pullId, path, viewed);
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

  /**
   * Posts an agent's draft on a mirrored thread to GitHub as the user (`body`: the text the tab showed),
   * then resolves the thread when the draft is a resolution, and reads the threads back. The draft's
   * row becomes GitHub's comment, so nothing is lost if the read fails.
   */
  async postDraft(thread: ReviewThread, draft: { id: string; body: string; githubDraft: GithubDraft }, ref: PullRef): Promise<void> {
    const release = this.claimDrafts([draft.id]);
    try {
      const row = this.store.comment(draft.id);
      if (row?.githubDraft !== draft.githubDraft || row.body !== draft.body) throw new GitHubError("That draft changed or was posted meanwhile; look at it again.");
      const posted = await this.github.reply(thread.githubThreadId!, draft.body);
      this.store.postedDraft(draft.id, posted.id, posted.author, draft.body);
    } finally {
      release();
    }
    if (draft.githubDraft === "resolve") {
      try {
        await this.github.setResolved(thread.githubThreadId!, true);
      } catch (error) {
        await this.sync(thread.sessionId, ref);
        throw new GitHubError(`Posted the reply, but could not resolve the thread on GitHub: ${failure(error)}`);
      }
    }
    await this.sync(thread.sessionId, ref);
  }

  /** Claims drafts for posting (all or none), or throws when one is being posted; the result lets them go. */
  private claimDrafts(ids: readonly string[]): () => void {
    if (ids.some((id) => this.posting.has(id))) throw new GitHubError("That draft is being posted already.");
    for (const id of ids) this.posting.add(id);
    return () => {
      for (const id of ids) this.posting.delete(id);
    };
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
  /**
   * The files of a `pr` session's diff, as its view last loaded them, or fetched now when no tab has
   * loaded it since the plugin started: what an AI run's comments are checked against.
   */
  async filesFor(sessionId: string, environment: Environment, ref: PullRef, patterns: readonly string[]): Promise<readonly DiffFile[]> {
    const known = this.loaded.get(sessionId);
    if (known !== undefined) return known.files;
    const pull = await this.load(environment, ref, patterns, false);
    this.loaded.set(sessionId, { pullId: pull.pullId, headSha: pull.details.headSha, baseSha: pull.details.baseSha, files: pull.diff.files });
    return pull.diff.files;
  }

  /** The plan for the session's comments, against the diff last loaded; null before a load. */
  plan(sessionId: string): ReviewPlan | null {
    const loaded = this.loaded.get(sessionId);
    return loaded === undefined ? null : reviewPlan(this.store.threads(sessionId), loaded.files);
  }

  /**
   * Submits the comments the user approved in the dialog, exactly as the dialog showed them (`items`:
   * each thread and its first comment's text), as one review with the verdict:
   *
   * - The pull request must still be at the commit the view showed, before anything is posted and
   *   again just before the last request (the submit), when a push during the drafting deletes the
   *   pending review and leaves every comment here. Between that last read and GitHub taking the
   *   submit there is still one request's time in which a push can land.
   * - A comment edited since the dialog read it is refused, not posted.
   * - Nothing is deleted: a line comment becomes the mirror of the GitHub thread it made (its replies
   *   and anything an agent wrote stay here, unposted); a whole-file or whole-diff one, now in the
   *   review's body, is resolved.
   */
  async submit(input: {
    sessionId: string;
    ref: PullRef;
    event: ReviewEvent;
    body: string;
    headSha: string;
    items: readonly { reviewThreadId: string; body: string }[];
    /** Agents' drafts the user approved, each by comment id with the text the dialog showed. */
    replies?: readonly { commentId: string; body: string }[];
  }): Promise<{ url: string | null; posted: number; blocked: ReviewPlan["blocked"]; warnings: string[] }> {
    const loaded = this.loaded.get(input.sessionId);
    if (loaded === undefined) throw new GitHubError("Load the pull request's view first.");
    const headNow = async () => {
      try {
        return (await this.github.pull(input.ref)).headRefOid;
      } catch (error) {
        throw new GitHubError(`Could not read the pull request from GitHub: ${failure(error)}`);
      }
    };
    const moved = new GitHubError("The pull request has new commits since this view loaded; reload it, check your comments, and submit again.");
    const meta = await this.github.pull(input.ref).catch((error: unknown) => {
      throw new GitHubError(`Could not read the pull request from GitHub: ${failure(error)}`);
    });
    if (meta.headRefOid !== input.headSha || loaded.headSha !== input.headSha) throw moved;
    const approved = new Map(input.items.map((item) => [item.reviewThreadId, item.body]));
    const approvedReplies = new Map((input.replies ?? []).map((reply) => [reply.commentId, reply.body]));
    const plan = reviewPlan(this.store.threads(input.sessionId), loaded.files, new Set(approved.keys()), new Set(approvedReplies.keys()));
    for (const entry of [...plan.lines, ...plan.body]) {
      if (approved.get(entry.reviewThreadId) !== entry.body) throw new GitHubError("A comment changed since you opened the dialog; open Submit review again to see it.");
    }
    for (const entry of plan.replies) {
      if (approvedReplies.get(entry.commentId) !== entry.body) throw new GitHubError("An agent's draft changed since you opened the dialog; open Submit review again to see it.");
    }
    const missing = [...approved.keys()].filter((id) => ![...plan.lines, ...plan.body, ...plan.blocked].some((entry) => entry.reviewThreadId === id));
    const missingReplies = [...approvedReplies.keys()].filter((id) => !plan.replies.some((entry) => entry.commentId === id));
    if (missing.length > 0 || missingReplies.length > 0) throw new GitHubError("A comment you chose is gone or closed; open Submit review again.");
    const body = reviewBody(input.body, plan.body.map((entry) => entry.text));
    if (input.event === "REQUEST_CHANGES" && body === "" && plan.lines.length === 0 && plan.replies.length === 0) throw new GitHubError("Requesting changes needs a comment or a review body.");
    // Claimed in the same turn as the check above, and held until each row records GitHub's comment.
    const release = this.claimDrafts(plan.replies.map((entry) => entry.commentId));
    try {
      return await this.submitPlan(input, meta.id, plan, body, async () => {
        if ((await headNow()) !== input.headSha) throw moved;
      });
    } finally {
      release();
    }
  }

  /** The submission of a checked plan (`submit`), as one review, and what it made of each comment. */
  private async submitPlan(
    input: { sessionId: string; ref: PullRef; event: ReviewEvent; headSha: string },
    pullId: string,
    plan: ReviewPlan,
    body: string,
    beforeSubmit: () => Promise<void>,
  ): Promise<{ url: string | null; posted: number; blocked: ReviewPlan["blocked"]; warnings: string[] }> {
    const result = await this.github.submitReview(
      pullId,
      input.headSha,
      input.event,
      body,
      plan.lines.map((entry) => entry.draft),
      beforeSubmit,
      plan.replies.map((entry) => ({ threadId: entry.githubThreadId, body: entry.body })),
    );
    plan.lines.forEach((entry, index) => {
      const made = result.threads[index];
      if (made === undefined) return;
      this.store.linkGithubThread(entry.reviewThreadId, made.threadId, made.commentId === null ? null : { commentId: entry.commentId, body: entry.body, githubCommentId: made.commentId });
    });
    for (const entry of plan.body) this.store.setStatus(entry.reviewThreadId, "resolved", false);
    // Each draft is now GitHub's comment; a resolution resolves its thread now the review is in.
    const warnings: string[] = [];
    for (const [index, entry] of plan.replies.entries()) {
      const posted = result.replies[index];
      if (posted !== undefined) this.store.postedDraft(entry.commentId, posted.id, posted.author, entry.body);
      if (!entry.resolve) continue;
      try {
        await this.github.setResolved(entry.githubThreadId, true);
      } catch (error) {
        warnings.push(`Could not resolve a thread on GitHub after posting its reply: ${failure(error)}`);
      }
    }
    await this.sync(input.sessionId, input.ref);
    this.publish(input.sessionId);
    return { url: result.url, posted: plan.lines.length + plan.body.length + plan.replies.length, blocked: plan.blocked, warnings };
  }
}
