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
  type ReviewView,
  type Severity,
  type Side,
  type Target,
  type TargetRequest,
  type ThreadStatus,
} from "../shared/types";
import { ignorePatterns, loadDiff, loadPatches, resolveTarget, ReviewUnavailable, workspaceOf, workspaceRefs } from "./diff";
import { sendPrompt } from "./prompt";
import type { ReviewStore } from "./store";

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
  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly settings: () => Promise<ReviewSettings>,
  ) {}

  /** The Review tab's whole view of a thread's diff. */
  async view(threadId: string, request: TargetRequest): Promise<ReviewView> {
    try {
      const environment = await workspaceOf(this.bb.sdk, threadId);
      const base = request.kind === "branch" || request.kind === "all" ? request.base : undefined;
      const refs = await workspaceRefs(this.bb.sdk, this.bb.log, environment, base);
      const target = resolveTarget(request, refs.defaultBase);
      const settings = await this.settings();
      const patterns = await ignorePatterns(this.bb.sdk, this.bb.log, environment, settings.ignorePatterns, settings.readIgnoreFiles);
      const diff = await loadDiff(this.bb.sdk, environment, target, patterns);
      const session = this.store.session(environment.id, targetKey(target));
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
        threads: this.store.threads(session.id),
      };
    } catch (error) {
      if (error instanceof ReviewUnavailable) return { ok: false, message: error.message };
      throw error;
    }
  }

  /** Patches bb left to load on demand. */
  async patches(threadId: string, target: Target, paths: readonly string[]) {
    const environment = await workspaceOf(this.bb.sdk, threadId);
    return loadPatches(this.bb.sdk, environment, target, paths);
  }

  threads(sessionId: string): ReviewThread[] {
    this.requireSession(sessionId);
    return this.store.threads(sessionId);
  }

  createThread(input: NewThreadInput): ReviewThread {
    const session = this.requireSession(input.sessionId);
    const placed = normalisePlace(input);
    const thread = this.store.createThread({ ...input, ...placed, body: requireText(input.body, "The comment") });
    this.publish(session.environmentId, session.id);
    return thread;
  }

  addUserComment(reviewThreadId: string, body: string): ReviewThread {
    const thread = this.requireThread(reviewThreadId);
    this.store.addComment({ threadId: thread.id, authorType: "user", authorName: "You", body: requireText(body, "The comment") });
    return this.changed(thread.id);
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

  /** The threads whose last send went to `callerThreadId`; with `all`, the closed ones too. */
  sentTo(callerThreadId: string, all: boolean): ReviewThread[] {
    const rows = this.store.threadsSentTo(callerThreadId);
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
    if (thread.environmentId !== null && this.store.sessionsOf(thread.environmentId).length > 0) {
      this.signal(thread.environmentId, { kind: "diff" });
    }
  }

  private async latestTurnStart(threadId: string): Promise<number | null> {
    const events = await this.bb.sdk.threads.events.list({ threadId, types: ["turn/started"], order: "desc", limit: "20" });
    // A sub-agent's turn carries the tool call that started it; only the thread's own turns count.
    const own = events.find((event) => event.type === "turn/started" && event.data.parentToolCallId === undefined);
    return own?.createdAt ?? null;
  }

  private findSent(callerThreadId: string, idPrefix: string): ReviewThread {
    const prefix = idPrefix.trim().toLowerCase();
    if (!/^[0-9a-f]{4,}$/.test(prefix)) {
      throw new ReviewError(`"${idPrefix}" is not a comment thread id (at least four hex characters).`, "invalid_id");
    }
    const matches = this.store.threadsSentTo(callerThreadId).filter((row) => row.id.startsWith(prefix));
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

  private async agentName(threadId: string): Promise<string> {
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

  private publish(environmentId: string, sessionId: string): void {
    this.signal(environmentId, { kind: "threads", sessionId });
  }

  private signal(environmentId: string, signal: RealtimeSignal): void {
    this.bb.realtime.publish(environmentChannel(environmentId), signal);
  }

  private requireSession(id: string) {
    const session = this.store.sessionById(id);
    if (session === null) throw new ReviewError(`No review session ${id}.`, "unknown_session");
    return session;
  }

  private requireThread(id: string): ReviewThread {
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
