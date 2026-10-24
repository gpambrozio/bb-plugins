/**
 * What the Review tab, the `bb diff-review` command and bb's thread events do to reviews. The RPC
 * handlers, the CLI and the event listeners in `server.ts` only translate into these calls.
 *
 * The user's side (the tab) is trusted; the agent's side (the CLI) is not: an agent may only answer a
 * thread whose last send went to the thread it runs in, as its `bb` reports that (AGENTS.md, "A plugin
 * CLI command knows its caller" — the id is a claim, not an identity).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  environmentChannel,
  GENERAL_PATH,
  targetKey,
  type RealtimeSignal,
  type ReviewThread,
  type Run,
  type ReviewView,
  type Severity,
  type Side,
  type Target,
  type TargetRequest,
  type ThreadStatus,
  type LoadReason,
  type ViewState,
  viewStateSchema,
} from "../shared/types";
import { ignorePatterns, loadDiff, loadPatches, resolveTarget, ReviewUnavailable, workspaceOf, workspaceRefs, workspaceState, type WorkspaceState } from "./diff";
import { sendPrompt } from "./prompt";
import type { ReviewStore, StoredRun } from "./store";

/** A run as the tab sees it, without the baseline only the server reads. */
export function publicRun(run: StoredRun): Run {
  const { baseline: _baseline, ...rest } = run;
  return rest;
}

/** A failure the caller caused, worded for them. */
export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface ReviewSettings {
  ignorePatterns: string;
  readIgnoreFiles: boolean;
}

export interface NewThreadInput {
  sessionId: string;
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  severity: Severity | null;
  anchorContent: string | null;
  body: string;
}

export type AgentAction = "reply" | "resolve" | "dismiss";

/** Names for the providers bb ships, for an agent's comments; any other provider shows its id. */
const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
};

/** The longest range a thread may cover, in lines. */
const MAX_RANGE_LINES = 2_000;

export class ReviewService {
  /** Each workspace's state at the end of its last turn, or when a tab first loaded it. */
  private readonly workspaceStates = new Map<string, WorkspaceState>();

  /** Told of every comment the user writes, after it is stored (for @-mentions); must not throw. */
  onUserComment: (thread: ReviewThread, body: string, viewerThreadId: string | null) => void = () => undefined;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly settings: () => Promise<ReviewSettings>,
  ) {}

  /**
   * The Review tab's whole view of a thread's diff. With `autoTarget` (the tab's first load, when it
   * was not opened on a chosen view), an empty uncommitted view gives way to the changes committed
   * since the base branch, when there are any; when both are empty, the uncommitted view stands.
   */
  async view(threadId: string, request: TargetRequest, autoTarget = false, reason: LoadReason = "unknown", tab = "?"): Promise<ReviewView> {
    try {
      const environment = await workspaceOf(this.bb.sdk, threadId);
      this.bb.log.debug(`Loading the ${request.kind} view of ${threadId}'s workspace ${environment.id} for tab ${tab} (${reason}).`);
      await this.seedWorkspaceState(environment.id);
      const base = request.kind === "branch" || request.kind === "all" ? request.base : undefined;
      const refs = await workspaceRefs(this.bb.sdk, this.bb.log, environment, base);
      let target = resolveTarget(request, refs.defaultBase);
      const settings = await this.settings();
      const patterns = await ignorePatterns(this.bb.sdk, this.bb.log, environment, settings.ignorePatterns, settings.readIgnoreFiles);
      let diff = await loadDiff(this.bb.sdk, environment, target, patterns);
      if (autoTarget && target.kind === "uncommitted" && diff.files.length === 0 && refs.defaultBase !== null) {
        const branch: Target = { kind: "branch", base: refs.defaultBase };
        const committed = await loadDiff(this.bb.sdk, environment, branch, patterns);
        if (committed.files.length > 0) {
          target = branch;
          diff = committed;
        }
      }
      const session = this.store.session(environment.id, targetKey(target));
      const threads = this.store.threads(session.id);
      return {
        ok: true,
        sessionId: session.id,
        environmentId: environment.id,
        target,
        defaultBase: refs.defaultBase,
        currentBranch: refs.currentBranch,
        commits: refs.commits,
        files: diff.files,
        ignoredPaths: diff.ignoredPaths,
        truncated: diff.truncated,
        threads,
        runs: this.store.openRuns(session.id).map(publicRun),
        viewState: this.viewState(threadId, session.id, threads),
      };
    } catch (error) {
      if (error instanceof ReviewUnavailable) return { ok: false, message: error.message };
      throw error;
    }
  }

  /**
   * What `threadId`'s tab kept of a view, minus the reply and edit drafts whose thread or comment is
   * gone (deleted, or cleared with the review). A stored copy that no longer parses counts as none.
   */
  private viewState(threadId: string, sessionId: string, threads: readonly ReviewThread[]): ViewState | null {
    const parsed = viewStateSchema.safeParse(this.store.viewState(threadId, sessionId));
    if (!parsed.success) return null;
    const threadIds = new Set(threads.map((thread) => thread.id));
    const commentIds = new Set(threads.flatMap((thread) => thread.comments.map((comment) => comment.id)));
    const drafts = Object.fromEntries(
      Object.entries(parsed.data.drafts).filter(([key]) => {
        if (key.startsWith("reply:")) return threadIds.has(key.slice("reply:".length));
        if (key.startsWith("edit:")) return commentIds.has(key.slice("edit:".length));
        return true;
      }),
    );
    // Folds of threads that are gone are dropped the same way.
    const expandedThreads = Object.fromEntries(Object.entries(parsed.data.expandedThreads ?? {}).filter(([id]) => threadIds.has(id)));
    return { ...parsed.data, drafts, expandedThreads };
  }

  /** Keeps what `threadId`'s tab holds of a session's view. */
  saveViewState(threadId: string, sessionId: string, state: ViewState): void {
    const session = this.requireSession(sessionId);
    this.store.saveViewState(threadId, session.id, state);
  }

  /** Patches bb left to load on demand. */
  async patches(threadId: string, target: Target, paths: readonly string[]) {
    const environment = await workspaceOf(this.bb.sdk, threadId);
    return loadPatches(this.bb.sdk, environment, target, paths);
  }

  /** A session's threads and its runs not yet closed. */
  sessionState(sessionId: string): { threads: ReviewThread[]; runs: Run[] } {
    this.requireSession(sessionId);
    return { threads: this.store.threads(sessionId), runs: this.store.openRuns(sessionId).map(publicRun) };
  }

  /** `viewerThreadId`: the thread whose Review tab it was written in, when the tab says. */
  createThread(input: NewThreadInput, viewerThreadId: string | null = null): ReviewThread {
    const session = this.requireSession(input.sessionId);
    const placed = normalisePlace(input);
    const thread = this.store.createThread({ ...input, ...placed, body: requireText(input.body, "The comment") });
    this.publish(session.environmentId, session.id);
    this.onUserComment(thread, input.body, viewerThreadId);
    return thread;
  }

  /** A thread an AI review run opened, already checked against the diff (`RunService.addComment`). */
  createAgentThread(input: NewThreadInput, authorName: string): ReviewThread {
    const session = this.requireSession(input.sessionId);
    const thread = this.store.createThread({ ...input, ...normalisePlace(input) }, { type: "agent", name: authorName });
    this.publish(session.environmentId, session.id);
    return thread;
  }

  addUserComment(reviewThreadId: string, body: string, viewerThreadId: string | null = null): ReviewThread {
    const thread = this.requireThread(reviewThreadId);
    this.store.addComment({ threadId: thread.id, authorType: "user", authorName: "You", body: requireText(body, "The comment") });
    const changed = this.changed(thread.id);
    this.onUserComment(changed, body, viewerThreadId);
    return changed;
  }

  editComment(commentId: string, body: string): ReviewThread {
    const comment = this.requireUserComment(commentId);
    this.store.editComment(comment.id, requireText(body, "The comment"));
    return this.changed(comment.threadId);
  }

  deleteComment(commentId: string): void {
    const comment = this.requireUserComment(commentId);
    const thread = this.requireThread(comment.threadId);
    this.store.deleteComment(comment.id);
    const session = this.requireSession(thread.sessionId);
    this.publish(session.environmentId, session.id);
  }

  setStatus(reviewThreadId: string, status: ThreadStatus): ReviewThread {
    const thread = this.requireThread(reviewThreadId);
    this.store.setStatus(thread.id, status, false);
    return this.changed(thread.id);
  }

  /**
   * Sends open threads to a bb thread working in the session's workspace, queued behind its current
   * turn if it is in one. The send is recorded first, so an agent quick enough to answer before
   * `threads.send` returns is still allowed to, and dropped again if bb refuses the message.
   */
  async send(input: { sessionId: string; threadId: string; reviewThreadIds: readonly string[]; note: string }) {
    const session = this.requireSession(input.sessionId);
    const thread = await this.bb.sdk.threads.get({ threadId: input.threadId });
    if (thread.environmentId !== session.environmentId) {
      throw new ReviewError("That thread works in another workspace; send the comments from its own Review tab.", "wrong_workspace");
    }
    const all = new Map(this.store.threads(session.id).map((row) => [row.id, row]));
    const chosen: ReviewThread[] = [];
    for (const id of new Set(input.reviewThreadIds)) {
      const row = all.get(id);
      if (row === undefined) throw new ReviewError(`No comment thread ${id} in this review.`, "unknown_thread");
      if (row.status !== "open") throw new ReviewError(`Comment thread ${id} is ${row.status}; reopen it to send it.`, "not_open");
      chosen.push(row);
    }
    if (chosen.length === 0) throw new ReviewError("Pick at least one open comment to send.", "nothing_to_send");

    const target = targetFromKey(session.targetKey);
    const text = sendPrompt({ target, threads: chosen, note: input.note });
    const send = this.store.recordSend(session.id, input.threadId, chosen.map((row) => row.id), input.note);
    try {
      const result = await this.bb.sdk.threads.send({
        threadId: input.threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text, mentions: [] }],
      });
      this.publish(session.environmentId, session.id);
      return { delivery: result.delivery, count: chosen.length };
    } catch (error) {
      this.store.dropSend(send.id);
      throw error;
    }
  }

  /** The threads an agent's thread may answer (`agentScope`); with `all`, the closed ones too. */
  sentTo(callerThreadId: string, all: boolean): ReviewThread[] {
    const rows = this.agentScope(callerThreadId);
    return all ? rows : rows.filter((row) => row.status === "open");
  }

  /** An agent's reply, resolution or dismissal, from `bb diff-review`. */
  async answer(callerThreadId: string | undefined, idPrefix: string, action: AgentAction, text: string): Promise<ReviewThread> {
    if (callerThreadId === undefined) {
      throw new ReviewError("Run this inside the bb thread the comments were sent to.", "not_in_thread");
    }
    const body = requireText(text, action === "reply" ? "The reply" : action === "resolve" ? "The summary" : "The reason");
    const thread = this.findSent(callerThreadId, idPrefix);
    const authorName = await this.agentName(callerThreadId);
    this.store.addComment({ threadId: thread.id, authorType: "agent", authorName, body });
    if (action !== "reply") this.store.setStatus(thread.id, action === "resolve" ? "resolved" : "dismissed", true);
    return this.changed(thread.id);
  }

  /**
   * After a turn of `thread` ends, the threads sent to it that it did not answer are marked "no
   * reply". Only threads sent before its latest turn started count: a send queued behind a turn that
   * was already running is answered in the next one. Any session in the thread's workspace is told
   * the files may have changed.
   */
  async turnEnded(thread: { id: string; environmentId: string | null }): Promise<void> {
    const waiting = this.store.waitingOn(thread.id);
    if (waiting.length > 0) {
      const started = await this.latestTurnStart(thread.id);
      const unanswered = waiting.filter((row) => started !== null && row.sentAt <= started);
      this.store.markNoReply(unanswered.map((row) => row.threadId));
      for (const sessionId of new Set(unanswered.map((row) => row.sessionId))) {
        const session = this.store.sessionById(sessionId);
        if (session !== null) this.publish(session.environmentId, session.id);
      }
    }
    if (thread.environmentId !== null && this.store.sessionsOf(thread.environmentId).length > 0 && (await this.workspaceChanged(thread.environmentId, thread.id))) {
      this.signal(thread.environmentId, { kind: "diff" });
    }
  }

  /**
   * Whether the workspace's diffs changed since the last turn that ended in it. Most turns change no
   * file (a reviewer answering a question, the thread under review reading a run's notice), and a
   * `diff` signal makes every open tab reload its whole view. Unknown or unreadable counts as changed.
   * Two turns ending together cannot both signal for one change: the compare and the update below
   * run in one step, after the state is read.
   */
  private async workspaceChanged(environmentId: string, threadId: string): Promise<boolean> {
    let state: WorkspaceState;
    try {
      state = await workspaceState(this.bb.sdk, environmentId);
    } catch (error) {
      this.bb.log.warn(`Could not read the state of ${environmentId}; telling its tabs to reload: ${error instanceof Error ? error.message : String(error)}`);
      this.workspaceStates.delete(environmentId);
      return true;
    }
    const previous = this.workspaceStates.get(environmentId);
    this.workspaceStates.set(environmentId, state);
    if (previous?.key === state.key) {
      this.bb.log.debug(`A turn of ${threadId} ended; ${environmentId} is unchanged (${state.summary}), so no reload.`);
      return false;
    }
    this.bb.log.debug(
      `A turn of ${threadId} ended; ${environmentId} ${previous === undefined ? "had no known state" : `changed from (${previous.summary})`} to (${state.summary}): telling its tabs to reload.`,
    );
    return true;
  }

  /**
   * Records a workspace's state the first time a tab loads one of its views, before the diff is read,
   * so the first turn to end after a plugin load does not reload every tab for nothing. A turn that
   * changes files ends after it, with another key.
   */
  private async seedWorkspaceState(environmentId: string): Promise<void> {
    if (this.workspaceStates.has(environmentId)) return;
    try {
      const state = await workspaceState(this.bb.sdk, environmentId);
      if (!this.workspaceStates.has(environmentId)) this.workspaceStates.set(environmentId, state);
    } catch (error) {
      this.bb.log.debug(`No state recorded for ${environmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async latestTurnStart(threadId: string): Promise<number | null> {
    const events = await this.bb.sdk.threads.events.list({ threadId, types: ["turn/started"], order: "desc", limit: "20" });
    // A sub-agent's turn carries the tool call that started it; only the thread's own turns count.
    const own = events.find((event) => event.type === "turn/started" && event.data.parentToolCallId === undefined);
    return own?.createdAt ?? null;
  }

  /**
   * The comment threads an agent's thread may read and answer: those whose last send went to it, and,
   * for an AI review run, every thread of the session it reviews.
   */
  agentScope(callerThreadId: string): ReviewThread[] {
    const byId = new Map(this.store.threadsSentTo(callerThreadId).map((row) => [row.id, row]));
    const reviewed = new Set(this.store.runsOfThread(callerThreadId).filter((run) => run.kind === "review").map((run) => run.sessionId));
    for (const sessionId of reviewed) for (const row of this.store.threads(sessionId)) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private findSent(callerThreadId: string, idPrefix: string): ReviewThread {
    const prefix = idPrefix.trim().toLowerCase();
    if (!/^[0-9a-f]{4,}$/.test(prefix)) {
      throw new ReviewError(`"${idPrefix}" is not a comment thread id (at least four hex characters).`, "invalid_id");
    }
    const matches = this.agentScope(callerThreadId).filter((row) => row.id.startsWith(prefix));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ReviewError(`"${idPrefix}" matches ${matches.length} threads (${matches.map((row) => row.id).join(", ")}); give more of the id.`, "ambiguous_id");
    }
    const exists = this.store.thread(prefix);
    if (exists !== null) {
      throw new ReviewError(`Comment thread ${exists.id} was not sent to this thread, so it cannot answer it here.`, "not_sent_here");
    }
    throw new ReviewError(`No comment thread ${idPrefix} was sent to this thread. Run \`bb diff-review list\` to see the ones that were.`, "unknown_thread");
  }

  /** How an agent's comments are signed: its thread's provider. */
  async agentName(threadId: string): Promise<string> {
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      return PROVIDER_NAMES[thread.providerId] ?? thread.providerId;
    } catch (error) {
      this.bb.log.warn(`Could not read thread ${threadId} for its provider: ${error instanceof Error ? error.message : String(error)}`);
      return "Agent";
    }
  }

  private changed(threadId: string): ReviewThread {
    const thread = this.requireThread(threadId);
    const session = this.requireSession(thread.sessionId);
    this.publish(session.environmentId, session.id);
    return thread;
  }

  /** Tells open tabs on a session's workspace that its threads or runs changed. */
  publishSession(sessionId: string): void {
    const session = this.store.sessionById(sessionId);
    if (session !== null) this.publish(session.environmentId, session.id);
  }

  private publish(environmentId: string, sessionId: string): void {
    this.signal(environmentId, { kind: "threads", sessionId });
  }

  private signal(environmentId: string, signal: RealtimeSignal): void {
    this.bb.realtime.publish(environmentChannel(environmentId), signal);
  }

  requireSession(id: string) {
    const session = this.store.sessionById(id);
    if (session === null) throw new ReviewError(`No review session ${id}.`, "unknown_session");
    return session;
  }

  requireThread(id: string): ReviewThread {
    const thread = this.store.thread(id);
    if (thread === null) throw new ReviewError(`No comment thread ${id}.`, "unknown_thread");
    return thread;
  }

  private requireUserComment(id: string) {
    const comment = this.store.comment(id);
    if (comment === null) throw new ReviewError(`No comment ${id}.`, "unknown_comment");
    if (comment.authorType !== "user") throw new ReviewError("Only your own comments can be changed.", "not_yours");
    return comment;
  }
}

function requireText(text: string, what: string): string {
  if (text.trim() === "") throw new ReviewError(`${what} is empty.`, "empty_text");
  return text;
}

/** The place a new thread is stored at: whole-diff and whole-file threads have no side and line 0. */
function normalisePlace(input: NewThreadInput): Pick<NewThreadInput, "filePath" | "side" | "startLine" | "endLine" | "anchorContent"> {
  if (input.filePath === GENERAL_PATH) return { filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, anchorContent: null };
  if (input.filePath.trim() === "") throw new ReviewError("A comment needs a file.", "invalid_place");
  if (input.startLine === 0) return { filePath: input.filePath, side: null, startLine: 0, endLine: 0, anchorContent: null };
  if (input.side === null) throw new ReviewError("A line comment needs a side.", "invalid_place");
  if (input.endLine < input.startLine) throw new ReviewError("A range must end at or after its start.", "invalid_place");
  if (input.endLine - input.startLine >= MAX_RANGE_LINES) throw new ReviewError(`A range may cover at most ${MAX_RANGE_LINES} lines.`, "invalid_place");
  return { filePath: input.filePath, side: input.side, startLine: input.startLine, endLine: input.endLine, anchorContent: input.anchorContent };
}

/** The view a session was made for, back from its key. */
export function targetFromKey(key: string): Target {
  if (key === "uncommitted") return { kind: "uncommitted" };
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "branch" || kind === "all") return { kind, base: value };
  if (kind === "commit") return { kind: "commit", sha: value };
  throw new Error(`Unknown review session key: ${key}`);
}
