/**
 * What the Review tab, the `bb diff-review` command and bb's thread events do to reviews. The RPC
 * handlers, the CLI and the event listeners in `server.ts` only translate into these calls.
 *
 * The user's side (the tab) is trusted; the agent's side (the CLI) is not: an agent may only answer a
 * thread whose last send went to the thread it runs in, as its `bb` reports that (AGENTS.md, "A plugin
 * CLI command knows its caller" — the id is a claim, not an identity).
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  environmentChannel,
  GENERAL_PATH,
  targetKey,
  isHostTarget,
  REVIEWS_CHANNEL,
  type RealtimeSignal,
  type OrphanReview,
  type ReviewSummary,
  type WorkspaceFile,
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
import { gitTarget, ignorePatterns, loadDiff, type DiffSources, loadPatches, resolveTarget, ReviewUnavailable, withThreadPatches, workspaceOf, workspaceRefs, workspaceState, type WorkspaceState } from "./diff";
import { parseRange, rangeText } from "../shared/git-spec";
import { OPEN_CHANNEL, reviewRoute } from "../shared/routes";
import { GitReads } from "./git";
import { createHostGit, createHostIndexState, createHostRangeCommits, type HostGit, type HostIndexState, type HostRangeCommits } from "./host-git";
import { sendPrompt } from "./prompt";
import type { ReviewStore, ReviewSummaryRow, StoredRun } from "./store";

/** A bb thread as `threads.get` answers. */
type BbThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

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
  /** The file's revision in the view the thread was made on. */
  fileRevision?: string | null;
}

export type AgentAction = "reply" | "resolve" | "dismiss";

/** Names for the providers bb ships, for an agent's comments; any other provider shows its id. */
const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
};

/** bb's environment changes that may change a diff, and how they are coalesced (milliseconds). */
const WORKSPACE_CHANGES: ReadonlySet<string> = new Set(["work-status-changed", "git-refs-changed", "status-changed"]);
const CHANGE_DEBOUNCE_MS = 400;
const CHANGE_MAX_WAIT_MS = 2_000;
/** How long a tab's watch lasts unless renewed; tabs renew every `LEASE_RENEW_MS` while they show. */
export const LEASE_MS = 90_000;
export const LEASE_RENEW_MS = 30_000;

/** The most paths the Files view's search lists, and the largest file it shows, in bytes. */
const FILE_SEARCH_LIMIT = 200;
const FILE_VIEW_MAX_BYTES = 1024 * 1024;

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

/** The longest range a thread may cover, in lines. */
const MAX_RANGE_LINES = 2_000;

export class ReviewService {
  /** Each workspace's state at the end of its last turn, or when a tab first loaded it. */
  private readonly workspaceStates = new Map<string, WorkspaceState>();
  /** Workspaces a tab has loaded, whose changes outside a turn are checked. */
  /**
   * The tabs showing each workspace's reviews right now, each a lease that lapses unless renewed
   * (`LEASE_MS`), and whether it shows a staged or unstaged view (which needs the index too).
   */
  private readonly leases = new Map<string, Map<string, { expiresAt: number; index: boolean }>>();
  /** Workspaces a tab has watched, whose changes while no tab shows them are only marked. */
  private readonly known = new Set<string>();
  /** Workspaces bb changed while no tab showed them: checked once when one shows again. */
  private readonly dirty = new Set<string>();
  private stopEnvironmentEvents: (() => void) | null = null;
  private readonly checks = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
  private readonly hostIndexState: HostIndexState;
  private readonly hostRangeCommits: HostRangeCommits;
  /** bb's Git plugin, which every diff read goes through, but the host entry's views. */
  readonly git: GitReads;
  /** The plugin's host entry: git on the workspace's machine, for the staged, unstaged and range views. */
  readonly sources: DiffSources;

  /** Told of every comment the user writes, after it is stored (for @-mentions); must not throw. */
  onUserComment: (thread: ReviewThread, body: string, viewerThreadId: string | null) => void = () => undefined;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly settings: () => Promise<ReviewSettings>,
    host?: HostGit,
  ) {
    this.git = new GitReads(bb.sdk, (message) => new ReviewUnavailable(message));
    this.sources = { git: this.git, host: host ?? createHostGit(bb) };
    this.hostIndexState = createHostIndexState(bb);
    this.hostRangeCommits = createHostRangeCommits(bb);
  }

  /**
   * The two commits a range view compares, read on the workspace's machine as the view's diff resolves
   * them, so an AI run is told the diff the tab shows.
   */
  async rangeCommits(environmentId: string, target: Extract<Target, { kind: "range" }>): Promise<{ baseSha: string; headSha: string }> {
    const environment = await this.bb.sdk.environments.get({ environmentId });
    if (environment.path === null) throw new ReviewUnavailable("This workspace has no checkout.");
    try {
      return await this.hostRangeCommits(environment.hostId, environment.path, { kind: "range", from: target.from, to: target.to, symmetric: target.symmetric });
    } catch (error) {
      throw new ReviewUnavailable(`Could not read the range ${rangeText(target)} on the workspace's machine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The Review tab's whole view of a thread's diff. With `autoTarget` (the tab's first load, when it
   * was not opened on a chosen view), an empty uncommitted view gives way to the changes committed
   * since the base branch, when there are any; when both are empty, the uncommitted view stands.
   */
  async view(
    threadId: string,
    request: TargetRequest,
    autoTarget = false,
    reason: LoadReason = "unknown",
    tab = "?",
    ignoreWhitespace = false,
  ): Promise<ReviewView> {
    try {
      const environment = await workspaceOf(this.bb.sdk, threadId);
      this.bb.log.debug(`Loading the ${request.kind} view of ${threadId}'s workspace ${environment.id} for tab ${tab} (${reason}).`);
      await this.seedWorkspaceState(environment.id);
      const base = request.kind === "branch" || request.kind === "all" ? request.base : undefined;
      const refs = await workspaceRefs(this.git, this.bb.log, environment, base);
      let target = resolveTarget(request, refs.defaultBase);
      const settings = await this.settings();
      const patterns = await ignorePatterns(this.bb.sdk, this.bb.log, environment, settings.ignorePatterns, settings.readIgnoreFiles);
      let diff =
        target.kind === "files"
          ? { files: [], ignoredPaths: [], truncated: false, mergeBaseRef: null, headRef: null, viewable: false }
          : await loadDiff(this.sources, this.bb.log, environment, target, patterns, ignoreWhitespace);
      if (autoTarget && target.kind === "uncommitted" && diff.files.length === 0 && refs.defaultBase !== null) {
        const branch: Target = { kind: "branch", base: refs.defaultBase };
        const committed = await loadDiff(this.sources, this.bb.log, environment, branch, patterns, ignoreWhitespace);
        if (committed.files.length > 0) {
          target = branch;
          diff = committed;
        }
      }
      const session = this.store.session(environment.id, targetKey(target));
      const threads = this.store.threads(session.id);
      const files = await withThreadPatches(this.git, this.bb.log, environment, target, diff.files, threads, ignoreWhitespace);
      return {
        ok: true,
        sessionId: session.id,
        environmentId: environment.id,
        target,
        defaultBase: refs.defaultBase,
        currentBranch: refs.currentBranch,
        commits: refs.commits,
        mergeBaseRef: diff.mergeBaseRef,
        headRef: diff.headRef,
        viewable: diff.viewable,
        files,
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

  /** Patches bb left to load on demand, at the revisions the view's file list gave. */
  async patches(threadId: string, target: Target, files: readonly { path: string; revision: string }[], ignoreWhitespace = false) {
    const environment = await workspaceOf(this.bb.sdk, threadId);
    return loadPatches(this.git, environment, target, files, ignoreWhitespace);
  }

  /**
   * Marks a file Viewed at the revision the tab showed, or clears its mark. The marks are bb's own,
   * so bb's diff panel shows the same.
   */
  async setViewed(threadId: string, target: Target, path: string, revision: string, viewed: boolean): Promise<void> {
    if (isHostTarget(target) || target.kind === "files") throw new ReviewError("bb's Viewed marks do not cover the staged, unstaged, range and Any file views.", "not_viewable");
    const environment = await workspaceOf(this.bb.sdk, threadId);
    if (viewed) await this.git.markViewed(environment.id, gitTarget(target), path, revision);
    else await this.git.clearViewed(environment.id, gitTarget(target), path);
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
      this.store.dropSend(send);
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
    // Everything that awaits bb comes first. The rights are read after it, in the same step as the
    // write: a send reassigned, or a run closed, while bb answered leaves the old caller refused and
    // every row as it was.
    const authorName = await this.agentName(callerThreadId);
    const turnStarted = await this.latestTurnStart(callerThreadId).catch(() => null);
    const thread = this.findSent(callerThreadId, idPrefix);
    this.store.answerAsAgent({
      threadId: thread.id,
      callerThreadId,
      ackBefore: turnStarted,
      authorName,
      body,
      status: action === "reply" ? null : action === "resolve" ? "resolved" : "dismissed",
    });
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
      // Each row is marked only if its thread still points at the send seen here: one sent on while
      // bb answered keeps its newer send.
      const unanswered = this.store.markNoReply(waiting.filter((row) => started !== null && row.sentAt <= started));
      for (const sessionId of new Set(unanswered.map((row) => row.sessionId))) {
        const session = this.store.sessionById(sessionId);
        if (session !== null) this.publish(session.environmentId, session.id);
      }
    }
    if (thread.environmentId !== null && this.store.sessionsOf(thread.environmentId).length > 0 && (await this.workspaceChanged(thread.environmentId, `A turn of ${thread.id} ended`))) {
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
  /**
   * The workspace's state, and, when one of its reviews is of the staged or unstaged changes, what is
   * staged: the uncommitted state alone does not change when a file is only staged.
   */
  private async currentState(environmentId: string): Promise<WorkspaceState> {
    const state = await workspaceState(this.git, environmentId);
    const indexed = [...this.activeLeases(environmentId)].some((lease) => lease.index);
    if (!indexed) return state;
    const environment = await this.bb.sdk.environments.get({ environmentId });
    if (environment.path === null) return state;
    const index = await this.hostIndexState(environment.hostId, environment.path);
    const summary = `${state.summary}, index ${index.slice(0, 12)}`;
    return { key: createHash("sha256").update(`${state.key}\0${index}`).digest("hex"), summary };
  }

  private async workspaceChanged(environmentId: string, cause: string): Promise<boolean> {
    let state: WorkspaceState;
    try {
      state = await this.currentState(environmentId);
    } catch (error) {
      this.bb.log.warn(`Could not read the state of ${environmentId}; telling its tabs to reload: ${error instanceof Error ? error.message : String(error)}`);
      this.workspaceStates.delete(environmentId);
      return true;
    }
    const previous = this.workspaceStates.get(environmentId);
    this.workspaceStates.set(environmentId, state);
    if (previous?.key === state.key) {
      this.bb.log.debug(`${cause}; ${environmentId} is unchanged (${state.summary}), so no reload.`);
      return false;
    }
    this.bb.log.debug(
      `${cause}; ${environmentId} ${previous === undefined ? "had no known state" : `changed from (${previous.summary})`} to (${state.summary}): telling its tabs to reload.`,
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
      const state = await this.currentState(environmentId);
      if (!this.workspaceStates.has(environmentId)) this.workspaceStates.set(environmentId, state);
    } catch (error) {
      this.bb.log.debug(`No state recorded for ${environmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The leases on a workspace not lapsed yet; lapsed ones are dropped. */
  private activeLeases(environmentId: string): Iterable<{ expiresAt: number; index: boolean }> {
    const tabs = this.leases.get(environmentId);
    if (tabs === undefined) return [];
    const now = Date.now();
    for (const [tab, lease] of tabs) if (lease.expiresAt <= now) tabs.delete(tab);
    if (tabs.size === 0) this.leases.delete(environmentId);
    return tabs.values();
  }

  private shown(environmentId: string): boolean {
    for (const _lease of this.activeLeases(environmentId)) return true;
    return false;
  }

  /**
   * A tab showing a view of `threadId`'s workspace takes (`active`) or gives back a lease, renewed while
   * it shows. While a workspace has one, bb's changes made outside any agent's turn (an edit the user
   * saves, a `git` command, a file staged) are checked: coalesced per workspace, the workspace's
   * content-sensitive state (each file's patch, and the index when a leased view is staged or
   * unstaged) decides whether its tabs reload, as at a turn's end, and reading it changes nothing, so
   * the check cannot set off another. With none, a change only marks the workspace, and the first tab
   * to show it again has it checked once.
   */
  async watch(threadId: string, tab: string, view: Target["kind"], active: boolean): Promise<void> {
    let environment;
    try {
      environment = await workspaceOf(this.bb.sdk, threadId);
    } catch (error) {
      // A workspace gone or never there has nothing to watch.
      if (error instanceof ReviewUnavailable) return;
      throw error;
    }
    const tabs = this.leases.get(environment.id) ?? new Map<string, { expiresAt: number; index: boolean }>();
    if (!active) {
      tabs.delete(tab);
      if (tabs.size === 0) this.leases.delete(environment.id);
      return;
    }
    const wasShown = this.shown(environment.id);
    tabs.set(tab, { expiresAt: Date.now() + LEASE_MS, index: view === "staged" || view === "unstaged" });
    this.leases.set(environment.id, tabs);
    this.known.add(environment.id);
    this.stopEnvironmentEvents ??= this.bb.sdk.subscribe({
      event: "environment:changed",
      callback: (event) => {
        if (event.id === undefined || !this.known.has(event.id)) return;
        if (!event.changes.some((change) => WORKSPACE_CHANGES.has(change))) return;
        if (this.shown(event.id)) this.scheduleCheck(event.id);
        else this.dirty.add(event.id);
      },
    });
    if (!wasShown && this.dirty.delete(environment.id)) this.scheduleCheck(environment.id);
  }

  private scheduleCheck(environmentId: string): void {
    const pending = this.checks.get(environmentId);
    const now = Date.now();
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      if (now - pending.since >= CHANGE_MAX_WAIT_MS) {
        this.checks.delete(environmentId);
        void this.checkChanged(environmentId);
        return;
      }
    }
    const since = pending?.since ?? now;
    const timer = setTimeout(() => {
      this.checks.delete(environmentId);
      void this.checkChanged(environmentId);
    }, CHANGE_DEBOUNCE_MS);
    this.checks.set(environmentId, { timer, since });
  }

  private async checkChanged(environmentId: string): Promise<void> {
    if (await this.workspaceChanged(environmentId, "bb saw the workspace change")) this.signal(environmentId, { kind: "diff" });
  }

  /** Stops watching; the plugin is going away. */
  dispose(): void {
    this.stopEnvironmentEvents?.();
    this.stopEnvironmentEvents = null;
    for (const pending of this.checks.values()) clearTimeout(pending.timer);
    this.checks.clear();
  }

  /** When the thread's latest own turn started (epoch ms), or null when bb has no record. */
  async latestTurnStart(threadId: string): Promise<number | null> {
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
    // A run closed (Close, Clear review) loses every right, those from sends to it included.
    if (this.store.isClosedRunThread(callerThreadId)) return [];
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

  /**
   * The tab changed files in a workspace (a suggestion applied, a revert): its tabs reload, and the
   * next turn's end compares against the new state.
   */
  workspaceEdited(environmentId: string, sessionId: string | null): void {
    this.workspaceStates.delete(environmentId);
    this.signal(environmentId, { kind: "diff" });
    if (sessionId !== null) this.publishSession(sessionId);
  }

  /** Tells open tabs on a session's workspace that its threads or runs changed. */
  publishSession(sessionId: string): void {
    const session = this.store.sessionById(sessionId);
    if (session !== null) this.publish(session.environmentId, session.id);
  }

  /** Tells open tabs on a workspace, and the Reviews page, that one of its sessions changed (or went). */
  publish(environmentId: string, sessionId: string): void {
    this.signal(environmentId, { kind: "threads", sessionId });
    this.bb.realtime.publish(REVIEWS_CHANNEL, { kind: "threads", sessionId } satisfies RealtimeSignal);
  }

  /** The most reviews the Reviews page lists. */
  static readonly LIST_LIMIT = 200;

  /**
   * The reviews with comment threads, newest first, each with a bb thread to open it in: the thread
   * whose tab showed it last, or else a thread still working in its workspace. A review with neither
   * (its workspace archived) is left out, since it can no longer be loaded (`orphanReviews`).
   */
  async listReviews(): Promise<ReviewSummary[]> {
    const rows = this.store.reviewSummaries(ReviewService.LIST_LIMIT);
    const openerOf = this.openers();
    const reviews: ReviewSummary[] = [];
    for (const row of rows) {
      const thread = await openerOf(row);
      if (thread === null) continue;
      reviews.push({
        sessionId: row.sessionId,
        environmentId: row.environmentId,
        target: targetFromKey(row.targetKey),
        openCount: row.openCount,
        totalCount: row.totalCount,
        updatedAt: row.updatedAt,
        threadId: thread.id,
        threadTitle: thread.title ?? thread.titleFallback ?? "Untitled thread",
        projectId: thread.projectId,
      });
    }
    return reviews;
  }

  /**
   * The reviews no live bb thread can open: no thread to open them in (`openers`) and their workspace
   * gone (bb says it is destroyed). The Reviews page leaves them out and offers to delete them; nothing
   * deletes them unasked. A workspace bb cannot be asked about is not taken for gone.
   */
  async orphanReviews(): Promise<OrphanReview[]> {
    return (await this.orphanCandidates()).map(({ orphan }) => orphan);
  }

  private async orphanCandidates(): Promise<{ orphan: OrphanReview; runs: StoredRun[] }[]> {
    const openerOf = this.openers();
    const gone = new Map<string, boolean>();
    const orphans: { orphan: OrphanReview; runs: StoredRun[] }[] = [];
    for (const row of this.store.reviewSummaries()) {
      const checked = await this.checkOrphan(row, openerOf, gone);
      if (checked !== null) orphans.push(checked);
    }
    return orphans;
  }

  /**
   * Whether one review is an orphan now, asked afresh (nothing shared with the checks of other
   * reviews), for the delete to check right before it deletes it: the review, with the runs (not
   * closed) it was checked with, or null.
   */
  async orphanCheck(sessionId: string): Promise<{ orphan: OrphanReview; runs: StoredRun[] } | null> {
    const row = this.store.reviewSummaries(1, sessionId)[0];
    return row === undefined ? null : this.checkOrphan(row, this.openers(), new Map());
  }

  /**
   * A review is an orphan when no thread can open it (`openers`), its workspace is gone, and none of
   * its runs still has a worker, in any workspace (a fixer in a worktree of its own, a run still
   * starting). The workers are asked last, closest to a delete.
   */
  private async checkOrphan(row: ReviewSummaryRow, openerOf: (row: ReviewSummaryRow) => Promise<BbThread | null>, gone: Map<string, boolean>): Promise<{ orphan: OrphanReview; runs: StoredRun[] } | null> {
    if ((await openerOf(row)) !== null) return null;
    if (!gone.has(row.environmentId)) gone.set(row.environmentId, await this.workspaceGone(row.environmentId));
    if (gone.get(row.environmentId) !== true) return null;
    const runs = this.store.openRuns(row.sessionId);
    if (await this.hasLiveWorker(runs)) return null;
    return {
      orphan: { sessionId: row.sessionId, environmentId: row.environmentId, target: targetFromKey(row.targetKey), openCount: row.openCount, totalCount: row.totalCount, updatedAt: row.updatedAt },
      runs,
    };
  }

  /**
   * Whether any of these runs still has a worker: one still starting (running, no thread yet), or a
   * thread that is not archived, wherever it works. A thread bb cannot be asked about counts as live;
   * a start that failed before it got a thread never had a worker.
   */
  private async hasLiveWorker(runs: readonly StoredRun[]): Promise<boolean> {
    for (const run of runs) {
      if (run.threadId === null) {
        if (run.status === "running") return true;
        continue;
      }
      try {
        if ((await this.bb.sdk.threads.get({ threadId: run.threadId })).archivedAt === null) return true;
      } catch (error) {
        this.bb.log.debug(`Could not read run ${run.id}'s thread ${run.threadId}, so its review stays: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      }
    }
    return false;
  }

  private async workspaceGone(environmentId: string): Promise<boolean> {
    try {
      const environment = await this.bb.sdk.environments.get({ environmentId });
      return environment.status === "destroyed" || environment.path === null;
    } catch (error) {
      this.bb.log.debug(`Could not read workspace ${environmentId}, so its reviews stay: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** `threads.get`, each thread asked once per call; null when bb cannot give it. */
  private threadLookup(): (threadId: string) => Promise<BbThread | null> {
    const threads = new Map<string, BbThread | null>();
    return async (threadId) => {
      if (!threads.has(threadId)) threads.set(threadId, await this.bb.sdk.threads.get({ threadId }).catch(() => null));
      return threads.get(threadId) ?? null;
    };
  }

  /**
   * Finds the bb thread a review opens in, or null: the thread whose tab showed it last, while it is
   * not archived and still works in the review's workspace, or else one still working there. Lookups
   * are shared across the rows of one call.
   */
  private openers(threadOf = this.threadLookup()): (row: ReviewSummaryRow) => Promise<BbThread | null> {
    const fallback = new Map<string, string | null>();
    return async (row) => {
      let thread = row.viewerThreadId === null ? null : await threadOf(row.viewerThreadId);
      if (thread === null || thread.archivedAt !== null || thread.environmentId !== row.environmentId) {
        if (!fallback.has(row.environmentId)) {
          const listed = await this.bb.sdk.threads.list({ environmentId: row.environmentId, archived: false, limit: 1 }).catch(() => []);
          fallback.set(row.environmentId, listed[0]?.id ?? null);
        }
        const id = fallback.get(row.environmentId) ?? null;
        thread = id === null ? null : await threadOf(id);
      }
      return thread === null || thread.archivedAt !== null ? null : thread;
    };
  }

  /**
   * `bb diff-review open`: asks the windows showing `threadId` to open its review of `request`, at
   * `file` when given, and returns where the review is and the Reviews page's route for it.
   */
  async requestOpen(threadId: string, request: TargetRequest, file: string | null): Promise<{ target: Target; route: string; inDiff: boolean | null }> {
    const environment = await workspaceOf(this.bb.sdk, threadId);
    const base = request.kind === "branch" || request.kind === "all" ? request.base : undefined;
    const refs = await workspaceRefs(this.git, this.bb.log, environment, base);
    const target = resolveTarget(request, refs.defaultBase);
    let inDiff: boolean | null = null;
    if (file !== null) {
      try {
        inDiff = (await loadDiff(this.sources, this.bb.log, environment, target, [])).files.some((entry) => entry.path === file);
      } catch {
        inDiff = null;
      }
    }
    const address = { threadId, target, file };
    this.bb.realtime.publish(OPEN_CHANNEL, address);
    return { target, route: reviewRoute(this.bb.pluginId, address), inDiff };
  }

  /** The Files view's search: workspace files whose path matches `query`, best first. */
  async searchFiles(threadId: string, query: string): Promise<{ paths: string[]; truncated: boolean }> {
    const environment = await this.checkout(threadId);
    const result = await this.bb.sdk.files.listPaths({ hostId: environment.hostId, path: environment.path, query, limit: FILE_SEARCH_LIMIT, includeFiles: true, includeDirectories: false });
    const prefix = `${environment.path.replace(/\/$/, "")}/`;
    return { paths: result.paths.map((entry) => (entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path)), truncated: result.truncated };
  }

  /** One workspace file as the Files view shows it: its text, or why there is none. */
  async readWorkspaceFile(threadId: string, path: string): Promise<WorkspaceFile> {
    const environment = await this.checkout(threadId);
    const absolute = posix.join(environment.path, path);
    if (!absolute.startsWith(`${environment.path.replace(/\/$/, "")}/`)) throw new ReviewError("That path is outside the workspace.", "invalid_place");
    let file;
    try {
      file = await this.bb.sdk.files.read({ hostId: environment.hostId, path: absolute });
    } catch (error) {
      throw new ReviewError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`, "changed");
    }
    const bytes = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    if (bytes.byteLength > FILE_VIEW_MAX_BYTES) return { path, content: null, reason: "This file is too large to show here.", revision: file.sha256 };
    if (bytes.includes(0)) return { path, content: null, reason: "Binary file; nothing to comment on.", revision: file.sha256 };
    return { path, content: bytes.toString("utf8"), reason: null, revision: file.sha256 };
  }

  private async checkout(threadId: string): Promise<Environment & { path: string }> {
    let environment;
    try {
      environment = await workspaceOf(this.bb.sdk, threadId);
    } catch (error) {
      if (error instanceof ReviewUnavailable) throw new ReviewError(error.message, "diff_unavailable");
      throw error;
    }
    if (environment.path === null) throw new ReviewError("This workspace has no checkout.", "diff_unavailable");
    return environment as Environment & { path: string };
  }

  /**
   * Open and all comment threads: in one workspace's reviews, or with null in the reviews the Reviews
   * page lists, for its sidebar badge. The two must agree, so a review the page leaves out (its
   * workspace archived, so it can no longer be opened) is not counted either.
   */
  async counts(environmentId: string | null): Promise<{ open: number; total: number }> {
    if (environmentId !== null) return this.store.threadCounts(environmentId);
    const reviews = await this.listReviews();
    return { open: reviews.reduce((sum, review) => sum + review.openCount, 0), total: reviews.reduce((sum, review) => sum + review.totalCount, 0) };
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
  if (kind === "staged" || kind === "unstaged" || kind === "files") return { kind };
  if (kind === "range") {
    const range = parseRange(value);
    if (range !== null) return range;
  }
  throw new Error(`Unknown review session key: ${key}`);
}
