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

export const authorTypeSchema = z.enum(["user", "agent"]);
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
export const targetRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("branch"), base: z.string().min(1).max(256).optional() }).strict(),
  z.object({ kind: z.literal("all"), base: z.string().min(1).max(256).optional() }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict(),
]);
export type TargetRequest = z.infer<typeof targetRequestSchema>;

/** A view with every part filled in; the key of a review session. */
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }).strict(),
  z.object({ kind: z.literal("branch"), base: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("all"), base: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;

export const commentSchema = z
  .object({
    id: z.string(),
    authorType: authorTypeSchema,
    /** Who wrote it: "You" for the user, the provider for an agent. */
    authorName: z.string(),
    body: z.string(),
    createdAt: z.number(),
    editedAt: z.number().nullable(),
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
    createdAt: z.number(),
    updatedAt: z.number(),
    comments: z.array(commentSchema),
    delivery: deliverySchema.nullable(),
  })
  .strict();
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

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
 * that leaves comments, a `mention` answering one thread an agent was @-mentioned in, or a `fix` that
 * got comments sent to a new thread.
 */
export const runKindSchema = z.enum(["review", "mention", "fix"]);
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
      files: z.array(diffFileSchema),
      /** Changed files left out by the ignore patterns. */
      ignoredPaths: z.array(z.string()),
      truncated: z.boolean(),
      threads: z.array(reviewThreadSchema),
      /** The session's AI runs not yet closed, newest first. */
      runs: z.array(runSchema),
    })
    .strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type ReviewView = z.infer<typeof reviewViewSchema>;

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
  }
}

/** Where a thread points, for people and agents: "src/a.ts:12-14 (new)", "src/a.ts (whole file)", … */
export function describeLocation(thread: Pick<ReviewThread, "filePath" | "side" | "startLine" | "endLine">): string {
  if (thread.filePath === GENERAL_PATH) return "the whole diff";
  if (thread.startLine === 0) return `${thread.filePath} (whole file)`;
  const lines = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  return `${thread.filePath}:${lines} (${thread.side === "old" ? "old side, removed lines" : "new side"})`;
}
