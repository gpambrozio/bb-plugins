/**
 * The review data both halves see: plain types and zod schemas, with no import of the SDK root, so the
 * app can use them at run time (AGENTS.md, "The app must not import the SDK root").
 *
 * The model follows diffity's (https://github.com/nilbuild/diffity, MIT): a review session per
 * workspace and view, threads anchored to a file, a side and a line range, and comments in each
 * thread. `GENERAL_PATH` marks a comment on the whole diff and `startLine` 0 one on a whole file, as
 * diffity's store does.
 */
import { z } from "zod";

import { rangeText, revisionSchema } from "./git-spec";
import { pullDetailsSchema, pullRefSchema, pullText } from "./github";

/** The file path of a thread about the whole diff rather than one file. */
export const GENERAL_PATH = "__general__";

/** The longest comment body the plugin stores, in characters. */
export const BODY_MAX_CHARS = 20_000;
/** The longest anchor snippet stored with a thread, in characters. */
export const ANCHOR_MAX_CHARS = 20_000;

export const sideSchema = z.enum(["old", "new"]);
/** Which version of a file a line number counts in: `old` is the removed side, `new` the added one. */
export type Side = z.infer<typeof sideSchema>;

export const threadStatusSchema = z.enum(["open", "resolved", "dismissed"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

/** diffity's severities. A thread may have none. */
export const severitySchema = z.enum(["must-fix", "suggestion", "nit", "question"]);
export type Severity = z.infer<typeof severitySchema>;
export const SEVERITIES: readonly Severity[] = severitySchema.options;

/** `github`: a comment read from the pull request's review threads on GitHub (the `pr` view). */
export const authorTypeSchema = z.enum(["user", "agent", "github"]);
export type AuthorType = z.infer<typeof authorTypeSchema>;

/**
 * Where a thread stands with the agent it was last sent to: `sent` until the agent replies, resolves
 * or dismisses it (`answered`), or until that agent's turn ends without a word on it (`no_reply`).
 */
export const deliveryStateSchema = z.enum(["sent", "answered", "no_reply"]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/**
 * The view under review, as the Review tab asks for it. `base` may be left out for the branch views;
 * the server fills in the workspace's merge-base branch.
 */
/**
 * Why the tab loads its whole view, for the plugin's debug log: it opened, the user picked another
 * view, a `diff` signal (the workspace changed, at a turn's end or outside one), the realtime link
 * came back, the reload button, "Try again" after an error, or a whitespace toggle.
 */
export const loadReasonSchema = z.enum(["open", "view", "diff-signal", "reconnect", "manual", "retry", "whitespace", "unknown"]);
export type LoadReason = z.infer<typeof loadReasonSchema>;

/**
 * The views raw git gives on the workspace's host (`git-spec.ts`): staged, unstaged, and a range
 * between two revisions (`from...to` when `symmetric`, else `from..to`).
 */
const hostTargets = [
  z.object({ kind: z.literal("staged") }).strict(),
  z.object({ kind: z.literal("unstaged") }).strict(),
  z.object({ kind: z.literal("range"), from: revisionSchema, to: revisionSchema, symmetric: z.boolean() }).strict(),
] as const;

/** Any file of the working tree, diff or not: comments on the file's own lines (the Files view). */
const filesTarget = z.object({ kind: z.literal("files") }).strict();

/** A GitHub pull request, read only: its head fetched into a private ref and diffed against its base. */
const pullTarget = pullRefSchema.extend({ kind: z.literal("pr") }).strict();

export const targetRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  filesTarget,
  pullTarget,
  z.object({ kind: z.literal("branch"), base: z.string().min(1).max(256).optional() }).strict(),
  z.object({ kind: z.literal("all"), base: z.string().min(1).max(256).optional() }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict(),
  ...hostTargets,
]);
export type TargetRequest = z.infer<typeof targetRequestSchema>;

/** A view with every part filled in; the key of a review session. */
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  filesTarget,
  pullTarget,
  z.object({ kind: z.literal("branch"), base: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("all"), base: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict(),
  ...hostTargets,
]);
export type Target = z.infer<typeof targetSchema>;

/** The views the plugin's host entry computes with git, rather than bb's Git plugin. */
export type HostTarget = Extract<Target, { kind: "staged" | "unstaged" | "range" }>;

export function isHostTarget(target: Target): target is HostTarget {
  return target.kind === "staged" || target.kind === "unstaged" || target.kind === "range";
}

/**
 * An agent's answer on a GitHub review thread, waiting for the user to post it: `reply`, or `resolve`
 * (the agent resolved or dismissed the thread; posting it also resolves the thread on GitHub).
 */
export const githubDraftSchema = z.enum(["reply", "resolve"]);
export type GithubDraft = z.infer<typeof githubDraftSchema>;

export const commentSchema = z
  .object({
    id: z.string(),
    authorType: authorTypeSchema,
    /** Who wrote it: "You" for the user, the provider for an agent. */
    authorName: z.string(),
    body: z.string(),
    createdAt: z.number(),
    editedAt: z.number().nullable(),
    /** Set on an agent's answer to a GitHub thread that the user has not posted yet. */
    githubDraft: githubDraftSchema.optional(),
  })
  .strict();
export type ReviewComment = z.infer<typeof commentSchema>;

export const deliverySchema = z
  .object({
    state: deliveryStateSchema,
    sendId: z.string(),
    /** The bb thread the comments went to. */
    threadId: z.string(),
    sentAt: z.number(),
  })
  .strict();
export type Delivery = z.infer<typeof deliverySchema>;

export const reviewThreadSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    /** A path in the diff, or `GENERAL_PATH`. */
    filePath: z.string(),
    /** Null for a whole-diff or whole-file thread. */
    side: sideSchema.nullable(),
    /** 0 for a whole-diff or whole-file thread. */
    startLine: z.number().int().min(0),
    endLine: z.number().int().min(0),
    status: threadStatusSchema,
    severity: severitySchema.nullable(),
    /** The commented lines' text when the thread was made, to find them again after edits. */
    anchorContent: z.string().nullable(),
    /** The file's revision when the thread was made (bb's Git plugin's), or null when not known. */
    fileRevision: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    comments: z.array(commentSchema),
    delivery: deliverySchema.nullable(),
    /** The GitHub review thread this mirrors (the `pr` view), or null for the plugin's own. */
    githubThreadId: z.string().nullable(),
  })
  .strict();
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

/**
 * A file's Viewed mark, bb's own (shared with bb's diff panel): `yes` at the file's current
 * revision, `changed` when it was marked at an earlier one ("changed since viewed"), `no` otherwise.
 */
export const viewedSchema = z.enum(["no", "yes", "changed"]);
export type Viewed = z.infer<typeof viewedSchema>;

export const diffFileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    changeKind: z.enum(["added", "copied", "deleted", "modified", "renamed", "type_changed"]),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
    /** `on_demand`: the patch is fetched when the user asks; `too_large`: it is never shown. */
    loadMode: z.enum(["auto", "on_demand", "too_large"]),
    untracked: z.boolean(),
    /** The file's content revision, as bb's Git plugin gives it; it changes when the file does. */
    revision: z.string(),
    viewed: viewedSchema,
    /** The unified patch for this file, when loaded. */
    patch: z.string().nullable(),
    patchTruncated: z.boolean(),
  })
  .strict();
export type DiffFile = z.infer<typeof diffFileSchema>;

export const commitSchema = z.object({ sha: z.string(), shortSha: z.string(), subject: z.string() }).strict();
export type Commit = z.infer<typeof commitSchema>;

/** diffity's review focus chips; a review run may also get free-form instructions. */
export const REVIEW_FOCUSES = ["Security", "Performance", "Correctness", "Naming", "Tests", "Types"] as const;

/** The reasoning levels bb's thread spawn takes. */
export const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);

/** The provider, model and reasoning a spawned thread runs with, as bb's provider picker gives them. */
export const executionSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    model: z.string().max(256),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: z.string().max(128).optional(),
  })
  .strict();
export type Execution = z.infer<typeof executionSchema>;

/**
 * An AI run the plugin started, in a visible thread of its own in the reviewed workspace: a `review`
 * that leaves comments (and, as the view's reviewer, answers @reviewer questions), a `mention` from
 * before @reviewer (a provider @-mention answering one thread), a `fix` that got comments sent to a
 * new thread, a `summary` of the change or an `explain`ed file or lines, each left as a comment.
 */
export const runKindSchema = z.enum(["review", "mention", "fix", "summary", "explain"]);
export type RunKind = z.infer<typeof runKindSchema>;

export const runStatusSchema = z.enum(["running", "done", "failed", "closed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    kind: runKindSchema,
    /** The run's bb thread; null when it could not be started. */
    threadId: z.string().nullable(),
    /** The comment thread a mention run answers. */
    reviewThreadId: z.string().nullable(),
    /** A review run's focus, as the user picked it. */
    focus: z.string().nullable(),
    providerId: z.string(),
    model: z.string().nullable(),
    status: runStatusSchema,
    /** The agent's last message when its turn ended, or why the run could not start. */
    summary: z.string().nullable(),
    /** Files that changed in the workspace while a review run ran; null before it ends. */
    changedFiles: z.array(z.string()).nullable(),
    createdAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export type Run = z.infer<typeof runSchema>;

/** Most unsent comments one tab keeps for a view, and most files whose fold it remembers. */
export const VIEW_STATE_MAX_DRAFTS = 200;
export const VIEW_STATE_MAX_FOLDS = 5_000;

/**
 * An unsent comment, kept as typed until it is sent or cancelled. Its key says what it belongs to:
 * `general`, `file:<path>`, `line:<path>` (with `range`: one line draft per file, as the tab offers),
 * `reply:<thread id>` or `edit:<comment id>`.
 */
export const draftSchema = z
  .object({
    body: z.string().max(BODY_MAX_CHARS),
    severity: severitySchema.nullable(),
    range: z.object({ side: sideSchema, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict().nullable(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;

/**
 * Where the tab was scrolled: `offset` pixels into the file `path` (the `index`th shown, the fallback
 * when that file left the diff), or with a null `path`, `offset` pixels from the top.
 */
export const scrollAnchorSchema = z.object({ path: z.string().max(4096).nullable(), index: z.number().int().nonnegative(), offset: z.number() }).strict();
export type ScrollAnchor = z.infer<typeof scrollAnchorSchema>;

/** What one thread's tab keeps of one view across navigation and restarts. `savedAt` orders copies. */
export const viewStateSchema = z
  .object({
    drafts: z.record(z.string().max(4200), draftSchema).refine((drafts) => Object.keys(drafts).length <= VIEW_STATE_MAX_DRAFTS, "Too many drafts."),
    /** Files the user folded (true) or unfolded (false); the rest follow the default. */
    collapsed: z.record(z.string().max(4096), z.boolean()).refine((folds) => Object.keys(folds).length <= VIEW_STATE_MAX_FOLDS, "Too many folds."),
    /** Comment threads the user folded (false) or opened (true) by hand; absent in older copies. */
    expandedThreads: z
      .record(z.string().max(64), z.boolean())
      .refine((threads) => Object.keys(threads).length <= VIEW_STATE_MAX_FOLDS, "Too many thread folds.")
      .optional(),
    scroll: scrollAnchorSchema.nullable(),
    savedAt: z.number(),
  })
  .strict();
export type ViewState = z.infer<typeof viewStateSchema>;

export const reviewViewSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      environmentId: z.string(),
      target: targetSchema,
      /** The branch the branch views compare against by default. */
      defaultBase: z.string().nullable(),
      currentBranch: z.string().nullable(),
      /** The branch's own commits since its merge base, newest first. */
      commits: z.array(commitSchema),
      /** The commit a branch view compares against, which a deleted file is opened at. */
      mergeBaseRef: z.string().nullable(),
      /** The commit a range view's new side is, which its files are opened at. */
      headRef: z.string().nullable(),
      /** Whether the view takes bb's Viewed marks (not for the staged, unstaged and range views). */
      viewable: z.boolean(),
      /** The pull request the `pr` view reviews. */
      pullRequest: pullDetailsSchema.nullable(),
      /** The pull request of the workspace's branch, from bb's GitHub PR Status, to offer its review. */
      branchPullRequest: pullRefSchema.extend({ title: z.string() }).strict().nullable(),
      files: z.array(diffFileSchema),
      /** Changed files left out by the ignore patterns. */
      ignoredPaths: z.array(z.string()),
      truncated: z.boolean(),
      threads: z.array(reviewThreadSchema),
      /** The session's AI runs not yet closed, newest first. */
      runs: z.array(runSchema),
      /** What this thread's tab kept of this view, or null the first time. */
      viewState: viewStateSchema.nullable(),
    })
    .strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type ReviewView = z.infer<typeof reviewViewSchema>;

/** A review with comment threads, as the Reviews page lists it. */
export const reviewSummarySchema = z
  .object({
    sessionId: z.string(),
    environmentId: z.string(),
    target: targetSchema,
    openCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    updatedAt: z.number(),
    /** The bb thread the review opens in: the one whose tab last showed it, else one in its workspace. */
    threadId: z.string(),
    threadTitle: z.string(),
    projectId: z.string(),
  })
  .strict();
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/**
 * A review no live bb thread can open (every thread of its workspace archived, the workspace itself
 * gone), which the Reviews page leaves out and offers to delete.
 */
export const orphanReviewSchema = z
  .object({
    sessionId: z.string(),
    environmentId: z.string(),
    target: targetSchema,
    openCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    updatedAt: z.number(),
  })
  .strict();
export type OrphanReview = z.infer<typeof orphanReviewSchema>;

/** A workspace file as the Files view shows it. */
export const workspaceFileSchema = z
  .object({
    path: z.string(),
    /** Null for a binary or too-large file, with `reason` saying which. */
    content: z.string().nullable(),
    reason: z.string().nullable(),
    /** The content's hash, as a thread on the file keeps it. */
    revision: z.string(),
  })
  .strict();
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** The realtime channel every review change is also told on, for the Reviews page and its badge. */
export const REVIEWS_CHANNEL = "reviews";

/** The realtime channel for everything about one workspace's reviews. */
export function environmentChannel(environmentId: string): string {
  return `environment:${environmentId}`;
}

/** What a realtime signal on an environment channel says changed. */
export const realtimeSignalSchema = z.discriminatedUnion("kind", [
  /** A thread, comment or run in this session changed; re-read them. */
  z.object({ kind: z.literal("threads"), sessionId: z.string() }).strict(),
  /** An agent's turn in this workspace ended; the files may have changed. */
  z.object({ kind: z.literal("diff") }).strict(),
]);
export type RealtimeSignal = z.infer<typeof realtimeSignalSchema>;

/** The key a session is stored under for a view. */
export function targetKey(target: Target): string {
  switch (target.kind) {
    case "uncommitted":
      return "uncommitted";
    case "branch":
      return `branch:${target.base}`;
    case "all":
      return `all:${target.base}`;
    case "commit":
      return `commit:${target.sha.toLowerCase()}`;
    case "staged":
    case "unstaged":
    case "files":
      return target.kind;
    case "range":
      return `range:${rangeText(target)}`;
    case "pr":
      return `pr:${pullText(target)}`;
  }
}

/** How a view reads in a sentence: "uncommitted changes", "commit abc1234", … */
export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "uncommitted":
      return "uncommitted changes";
    case "branch":
      return `committed changes since ${target.base}`;
    case "all":
      return `all changes since ${target.base}, committed and not`;
    case "commit":
      return `commit ${target.sha.slice(0, 7)}`;
    case "staged":
      return "staged changes (HEAD against the index)";
    case "unstaged":
      return "unstaged changes (the index against the working tree)";
    case "range":
      return `the range ${rangeText(target)}`;
    case "files":
      return "files of the working tree as they are now (comments on their own lines, not on a diff)";
    case "pr":
      return `pull request ${pullText(target)}`;
  }
}

/** Where a thread points, for people and agents: "src/a.ts:12-14 (new)", "src/a.ts (whole file)", … */
export function describeLocation(thread: Pick<ReviewThread, "filePath" | "side" | "startLine" | "endLine">): string {
  if (thread.filePath === GENERAL_PATH) return "the whole diff";
  if (thread.startLine === 0) return `${thread.filePath} (whole file)`;
  const lines = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  return `${thread.filePath}:${lines} (${thread.side === "old" ? "old side, removed lines" : "new side"})`;
}
