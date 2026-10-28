/**
 * AI runs: threads the plugin starts in the reviewed workspace, visible in bb's sidebar so the user can
 * watch, steer and approve them.
 *
 * - **review** — an AI review with an optional focus, leaving comments with the `diff_review_*` tools.
 *   bb cannot make a thread read-only (its least privileged mode is `accept-edits`), so the
 *   workspace's uncommitted changes are fingerprinted before and after, and every file that changed
 *   while it ran is listed on the run.
 *   The latest review run of a view not yet closed is the view's **reviewer**: a user comment with
 *   `@reviewer` or `@agent` goes to its thread as a follow-up turn, and it answers in the comment
 *   thread. With no reviewer, such a comment starts one (a review run that answers the question first).
 * - **mention** — kept for runs from before the reviewer: a provider @-mention used to start one.
 * - **fix** — "Fix in a new thread": the comments go to a new thread instead of the one under review.
 *
 * Mention and fix runs are sends (`sends` ledger), so the agent answers through the same checks as the
 * thread under review. None is a child of the user's thread, so none posts into it. Each thread
 * carries its run id in the plugin's metadata, which `bb.agents.configure` reads to give it the tools;
 * the tools check the caller against the store, so the metadata grants nothing by itself.
 */
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { mentionsReviewer } from "../shared/mentions";
import { contentLines, linesText, parsePatchLines, type PatchLines } from "../shared/patch-lines";
import {
  describeLocation,
  GENERAL_PATH,
  reasoningLevelSchema,
  type Execution,
  type ReviewThread,
  type Run,
  type Severity,
  type Side,
} from "../shared/types";
import { ignorePatterns, loadDiff, loadPatches, ReviewUnavailable, uncommittedFingerprint, type Fingerprint } from "./diff";
import { explainPrompt, fixPrompt, reviewerPrompt, reviewPrompt, summaryPrompt } from "./run-prompts";
import { publicRun, ReviewError, targetFromKey, type ReviewService, type ReviewSettings } from "./review";
import { newId, pendingRunThread, type RecordedSend, type ReviewStore } from "./store";
import { RUN_METADATA_KEY } from "./tool-names";

type Sdk = BbPluginApi["sdk"];

export interface RunSettings extends ReviewSettings {
  aiProvider: string;
  aiModel: string;
  aiPermissionMode: string;
}

/** The permission modes a run may start in: bb's "Approve for me" (`auto`) and "Accept edits". */
export const RUN_PERMISSION_MODES = ["auto", "accept-edits"] as const;
export type RunPermissionMode = (typeof RUN_PERMISSION_MODES)[number];

/** The setting's mode, or `auto` when it holds anything else. */
export function runPermissionMode(value: string): RunPermissionMode {
  return (RUN_PERMISSION_MODES as readonly string[]).includes(value) ? (value as RunPermissionMode) : "auto";
}

/** The modes bb starts a thread in; a provider supports some of them (`capabilities.permissionModes`). */
export type SpawnPermissionMode = RunPermissionMode | "full";

/**
 * The mode a run's thread starts in: the setting's, when its provider supports it (or bb did not say
 * which it does); otherwise full. bb refuses a mode the provider lacks (opencode supports only Accept
 * edits and full), and the owner chose a run in full mode over one that fails.
 */
export function spawnPermissionMode(configured: RunPermissionMode, supported: readonly string[] | null): SpawnPermissionMode {
  return supported === null || supported.includes(configured) ? configured : "full";
}

/** The longest run summary kept, in characters. */
const SUMMARY_MAX_CHARS = 4_000;

export interface AgentCommentInput {
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  severity: Severity | null;
  body: string;
}

export class RunService {
  /** Each view's latest question to its reviewer: the next one waits for it, so two never race. */
  private readonly asking = new Map<string, Promise<unknown>>();
  /**
   * How many times each view was cleared. A start captures it before it awaits anything and gives up
   * if it moved, so a run asked for before a Clear review never appears in the cleared view.
   */
  private readonly clears = new Map<string, number>();

  private clearCount(sessionId: string): number {
    return this.clears.get(sessionId) ?? 0;
  }

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ReviewStore,
    private readonly review: ReviewService,
    private readonly settings: () => Promise<RunSettings>,
  ) {}

  /**
   * What the run pickers start on: the provider in the settings (Claude Code unless changed), its
   * model from the settings when that model exists, else the provider's default, at that model's
   * default reasoning. Null, with the reason, when the provider lists no models here.
   */
  async defaults(threadId: string): Promise<{ execution: Execution | null; message: string | null; permissionMode: RunPermissionMode }> {
    const settings = await this.settings();
    const permissionMode = runPermissionMode(settings.aiPermissionMode);
    return { ...(await this.defaultExecution(threadId, settings)), permissionMode };
  }

  private async defaultExecution(threadId: string, settings: RunSettings): Promise<{ execution: Execution | null; message: string | null }> {
    const thread = await this.bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return { execution: null, message: "This thread has no workspace yet." };
    const providerId = settings.aiProvider.trim() || "claude-code";
    const options = await this.bb.sdk.providers.models({ environmentId: thread.environmentId, providerId });
    if (options.modelLoadError !== null) {
      return { execution: null, message: options.modelLoadError.detail ?? `${providerId} could not list its models (${options.modelLoadError.code}).` };
    }
    const wanted = settings.aiModel.trim();
    const model =
      options.models.find((entry) => wanted !== "" && (entry.model === wanted || entry.id === wanted)) ??
      options.models.find((entry) => entry.isDefault) ??
      options.models[0];
    if (model === undefined) return { execution: null, message: `${providerId} lists no models here.` };
    return { execution: { providerId, model: model.model, reasoningLevel: reasoningLevel(model.defaultReasoningEffort) }, message: null };
  }

  /** The permission modes a provider supports in an environment, as bb reports them; null when bb does not say. */
  private async providerPermissionModes(environmentId: string, providerId: string): Promise<readonly string[] | null> {
    try {
      const providers = await this.bb.sdk.providers.list({ environmentId });
      return providers.find((provider) => provider.id === providerId)?.capabilities.permissionModes ?? null;
    } catch (error) {
      this.bb.log.warn(`Could not read ${providerId}'s permission modes; starting in the configured one: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Starts an AI review of a session's view, as a child of `threadId`, the thread under review. */
  async startReview(input: { sessionId: string; threadId: string; focuses: readonly string[]; instructions: string; execution: Execution }): Promise<Run> {
    const session = this.review.requireSession(input.sessionId);
    const clears = this.clearCount(session.id);
    const target = targetFromKey(session.targetKey);
    const focus = input.focuses.length === 0 ? null : input.focuses.join(", ");
    const prompt = reviewPrompt({ target, focus, instructions: input.instructions });
    const title = `Review: ${focus === null ? "changes" : focus}`;
    return this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: input.threadId,
      kind: "review",
      reviewThreadId: null,
      focus,
      execution: input.execution,
      title,
      prompt,
      baseline: () => this.fingerprint(session.environmentId),
      clears,
    });
  }

  /** "Summarize": a run that leaves a summary of the view's change as a comment on the whole diff. */
  async startSummary(input: { sessionId: string; threadId: string; execution: Execution }): Promise<Run> {
    const session = this.review.requireSession(input.sessionId);
    const clears = this.clearCount(session.id);
    return this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: input.threadId,
      kind: "summary",
      reviewThreadId: null,
      focus: null,
      execution: input.execution,
      title: "Summary of the changes",
      prompt: summaryPrompt(targetFromKey(session.targetKey)),
      baseline: () => this.fingerprint(session.environmentId),
      clears,
    });
  }

  /**
   * "Explain": a run that explains a file (`startLine` 0) or lines of it and leaves the explanation as
   * a comment there. It runs the settings' provider and model, as a reviewer an @reviewer starts does.
   */
  async startExplain(input: { sessionId: string; threadId: string; filePath: string; side: Side | null; startLine: number; endLine: number; code: string | null }): Promise<Run> {
    const session = this.review.requireSession(input.sessionId);
    const clears = this.clearCount(session.id);
    const place = { filePath: input.filePath, side: input.startLine === 0 ? null : (input.side ?? "new"), startLine: input.startLine, endLine: Math.max(input.endLine, input.startLine), code: input.code };
    const lines = place.startLine === 0 ? "" : place.startLine === place.endLine ? `:${place.startLine}` : `:${place.startLine}-${place.endLine}`;
    return this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: input.threadId,
      kind: "explain",
      reviewThreadId: null,
      focus: `${place.filePath}${lines}`,
      execution: async () => {
        const settings = await this.settings();
        return { providerId: settings.aiProvider.trim() || "claude-code", model: settings.aiModel.trim(), reasoningLevel: "medium" };
      },
      reasoningFromProvider: true,
      title: `Explain ${posix.basename(place.filePath)}${lines}`,
      prompt: explainPrompt(targetFromKey(session.targetKey), place),
      baseline: () => this.fingerprint(session.environmentId),
      clears,
    });
  }

  /** "Fix in a new thread": sends open comment threads to a new thread in the same workspace. */
  async fixInNewThread(input: { sessionId: string; threadId: string; reviewThreadIds: readonly string[]; note: string; execution: Execution }): Promise<{ run: Run; count: number }> {
    const session = this.review.requireSession(input.sessionId);
    const clears = this.clearCount(session.id);
    const chosen = this.openThreads(session.id, input.reviewThreadIds);
    const target = targetFromKey(session.targetKey);
    const prompt = fixPrompt({ target, threads: chosen, note: input.note });
    const title = `Review fixes: ${chosen.length} comment${chosen.length === 1 ? "" : "s"}`;
    const run = await this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: input.threadId,
      kind: "fix",
      reviewThreadId: null,
      focus: null,
      execution: input.execution,
      title,
      prompt,
      baseline: async () => null,
      grants: { reviewThreadIds: chosen.map((row) => row.id), note: input.note },
      clears,
    });
    return { run, count: chosen.length };
  }

  /**
   * A user comment with `@reviewer` or `@agent` (outside code) asks the view's reviewer about its
   * thread, in the background; a failure to start one shows as a failed run. Agents' comments never
   * come here (`ReviewService` calls this for the user's own comments only).
   */
  onUserComment(thread: ReviewThread, body: string, viewerThreadId: string | null): void {
    if (!mentionsReviewer(body)) return;
    void this.askReviewer(thread.id, viewerThreadId).catch((error: unknown) => {
      this.bb.log.warn(`Could not ask the reviewer about ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Sends a comment thread to its view's reviewer, one question per view at a time.
   * `viewerThreadId`: the thread whose Review tab the comment was written in; a new reviewer becomes
   * its child.
   */
  askReviewer(reviewThreadId: string, viewerThreadId: string | null = null): Promise<Run | null> {
    const thread = this.review.requireThread(reviewThreadId);
    const previous = this.asking.get(thread.sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.sendToReviewer(reviewThreadId, viewerThreadId));
    this.asking.set(thread.sessionId, next);
    void next.finally(() => {
      if (this.asking.get(thread.sessionId) === next) this.asking.delete(thread.sessionId);
    }).catch(() => undefined);
    return next;
  }

  /**
   * Queues the thread as a follow-up turn of the view's reviewer, or starts a reviewer when the view
   * has none (never reviewed, closed, cleared, or its thread is gone). A question still queued behind
   * a turn the reviewer has not started yet is not queued again: that turn reads the thread as it is
   * when it runs. Once the turn that took it has started (it may already have read the thread), a new
   * question gets a turn of its own, and the earlier turn's answer does not count as the answer to it
   * (`answerAsAgent`). Returns null when nothing was sent.
   */
  private async sendToReviewer(reviewThreadId: string, viewerThreadId: string | null): Promise<Run | null> {
    const asked = this.review.requireThread(reviewThreadId);
    const clears = this.clearCount(asked.sessionId);
    const reviewer = this.store.reviewerRun(asked.sessionId);
    let queuedAlready = false;
    if (reviewer !== null && reviewer.threadId !== null && asked.delivery?.state === "sent" && asked.delivery.threadId === reviewer.threadId) {
      const started = await this.review.latestTurnStart(reviewer.threadId).catch(() => null);
      queuedAlready = started !== null && asked.delivery.sentAt > started;
    }
    // The await above may have seen a Clear review: the question is gone with the review.
    if (this.clearCount(asked.sessionId) !== clears) return null;
    if (queuedAlready) return null;
    const thread = this.review.requireThread(reviewThreadId);
    const session = this.review.requireSession(thread.sessionId);
    const target = targetFromKey(session.targetKey);
    if (reviewer !== null && reviewer.threadId !== null && this.store.run(reviewer.id)?.status !== "closed") {
      const send = this.store.recordSend(session.id, reviewer.threadId, [thread.id], "");
      try {
        await this.bb.sdk.threads.send({ threadId: reviewer.threadId, mode: "queue-if-active", input: [{ type: "text", text: reviewerPrompt(target, thread, true), mentions: [] }] });
        this.store.restartRun(reviewer.id);
        this.review.publishSession(session.id);
        return publicRun(this.store.run(reviewer.id)!);
      } catch (error) {
        // Its thread is gone (archived or deleted outside the tab): close that run and start anew.
        this.store.dropSend(send);
        this.store.closeRun(reviewer.id);
        this.bb.log.info(`Reviewer run ${reviewer.id} could not take a follow-up (${error instanceof Error ? error.message : String(error)}); starting a new one.`);
        if (this.clearCount(session.id) !== clears) return null;
        this.review.requireThread(reviewThreadId);
      }
    }
    return this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: viewerThreadId,
      kind: "review",
      reviewThreadId: null,
      focus: null,
      execution: async () => {
        const settings = await this.settings();
        return { providerId: settings.aiProvider.trim() || "claude-code", model: settings.aiModel.trim(), reasoningLevel: "medium" };
      },
      reasoningFromProvider: true,
      title: `Reviewer: ${describeLocation(thread)}`,
      prompt: reviewerPrompt(target, thread, false),
      baseline: () => this.fingerprint(session.environmentId),
      grants: { reviewThreadIds: [thread.id], note: "" },
      clears,
    });
  }

  /**
   * Closes a run: drops it from the tab and archives its thread. It is closed first, so it loses its
   * rights (its sends' included) before the archive is even asked for.
   */
  async close(runId: string): Promise<void> {
    const run = this.store.run(runId);
    if (run === null) throw new ReviewError(`No run ${runId}.`, "unknown_run");
    const wasOpen = run.status !== "closed";
    this.store.closeRun(run.id);
    this.review.publishSession(run.sessionId);
    if (wasOpen) await this.archive(run);
  }

  /**
   * Clears a session's review: every comment thread is deleted and every open run closed, its thread
   * archived. The store goes first, so a run still working when its thread is archived finds its
   * rights gone (a closed review run cannot comment, and no send is left to answer).
   */
  async clearReview(sessionId: string): Promise<{ deletedThreads: number; closedRuns: number }> {
    const session = this.review.requireSession(sessionId);
    // Starts already asked for but not yet written as runs see this and give up.
    this.clears.set(session.id, this.clearCount(session.id) + 1);
    const deletedThreads = this.store.threads(session.id).length;
    const open = this.store.clearSession(session.id);
    this.review.publishSession(session.id);
    await Promise.all(open.map((run) => this.archive(run)));
    return { deletedThreads, closedRuns: open.length };
  }

  private async archive(run: { id: string; threadId: string | null }): Promise<void> {
    if (run.threadId === null) return;
    try {
      await this.bb.sdk.threads.archive({ threadId: run.threadId });
    } catch (error) {
      // The user may have archived or deleted it already; the run closes either way.
      this.bb.log.warn(`Could not archive ${run.threadId} for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A run thread's turn ended: the run is done (or failed), with the agent's last words as its
   * summary, unless a question is still queued for it. `ReviewService.turnEnded` runs first and marks
   * the sends that turn should have answered "no reply", so a send still waiting was queued behind
   * this turn and the next turn will take it.
   */
  async turnEnded(threadId: string, lastAssistantText: string | null, failed: boolean): Promise<void> {
    if (!failed && this.store.waitingOn(threadId).length > 0) return;
    const runs = this.store.runsOfThread(threadId).filter((run) => run.status === "running");
    for (const run of runs) {
      const summary = lastAssistantText === null ? null : lastAssistantText.slice(0, SUMMARY_MAX_CHARS);
      let changed: string[] | null = null;
      if (readsOnly(run.kind) && run.baseline !== null) {
        const session = this.store.sessionById(run.sessionId);
        if (session !== null) changed = changedFiles(JSON.parse(run.baseline) as Fingerprint, await this.fingerprint(session.environmentId));
      }
      this.store.finishRun(run.id, failed ? "failed" : "done", summary, changed);
      this.review.publishSession(run.sessionId);
    }
  }

  /**
   * An AI review's comment. The caller must be a review run's thread, and the lines must be shown in
   * the session's current diff on that side; a refusal says which lines are, so the agent can retry
   * (as diffity's `add_comment` does).
   */
  async addComment(callerThreadId: string, input: AgentCommentInput): Promise<ReviewThread> {
    const run = this.store.runsOfThread(callerThreadId).find((row) => readsOnly(row.kind));
    if (run === undefined) throw new ReviewError("Only an AI review, summary or explanation run can add comments; answer the threads sent to you instead.", "not_a_review_run");
    const session = this.review.requireSession(run.sessionId);
    const body = input.body.trim() === "" ? null : input.body;
    if (body === null) throw new ReviewError("The comment is empty.", "empty_text");
    let anchorContent: string | null = null;
    let fileRevision: string | null = null;
    if (input.filePath !== GENERAL_PATH) {
      const { lines, revision } = await this.linesOf(session.environmentId, session.targetKey, input.filePath);
      fileRevision = revision;
      if (input.startLine > 0) {
        const side = input.side ?? "new";
        const endLine = Math.max(input.endLine, input.startLine);
        anchorContent = linesText(lines, side, input.startLine, endLine);
        if (anchorContent === null) {
          throw new ReviewError(
            `Lines ${input.startLine}-${endLine} of ${input.filePath} are not all shown on the ${side} side of the diff. Lines shown there: ${ranges([...(side === "old" ? lines.old : lines.new).keys()]) || "none"}.`,
            "line_not_in_diff",
          );
        }
        input = { ...input, side, endLine };
      }
    }
    const authorName = await this.review.agentName(callerThreadId);
    // The checks above awaited bb; the run may have been closed (Close, Clear review) meanwhile.
    if (this.store.runsOfThread(callerThreadId).every((row) => row.id !== run.id)) {
      throw new ReviewError("This review run was closed; its comments are no longer taken.", "not_a_review_run");
    }
    return this.review.createAgentThread({ ...input, sessionId: session.id, anchorContent, body, fileRevision }, authorName);
  }

  /**
   * The lines a comment on `path` may be on: the diff's, or in the Any file view the file's own (read
   * through bb on the workspace's machine), with the revision the thread keeps.
   */
  private async linesOf(environmentId: string, targetKey: string, path: string): Promise<{ lines: PatchLines; revision: string }> {
    if (targetFromKey(targetKey).kind !== "files") {
      const { patch, revision } = await this.patchOf(environmentId, targetKey, path);
      return { lines: parsePatchLines(patch), revision };
    }
    const environment = await this.bb.sdk.environments.get({ environmentId });
    const absolute = environment.path === null ? null : posix.join(environment.path, path);
    if (environment.path === null || absolute === null || !absolute.startsWith(`${environment.path.replace(/\/$/, "")}/`)) {
      throw new ReviewError(`${path} is not a file of this workspace.`, "file_not_in_diff");
    }
    let file;
    try {
      file = await this.bb.sdk.files.read({ hostId: environment.hostId, path: absolute });
    } catch (error) {
      throw new ReviewError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`, "file_not_in_diff");
    }
    const content = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    return { lines: contentLines(content), revision: file.sha256 };
  }

  private async patchOf(environmentId: string, targetKey: string, path: string): Promise<{ patch: string; revision: string }> {
    // Reads the ignore files like a tab's load does; this line tells the two apart in the log.
    this.bb.log.debug(`Reading the diff of ${environmentId} to check a review comment on ${path}.`);
    const environment = await this.bb.sdk.environments.get({ environmentId });
    const target = targetFromKey(targetKey);
    const settings = await this.settings();
    const patterns = await ignorePatterns(this.bb.sdk, this.bb.log, environment, settings.ignorePatterns, settings.readIgnoreFiles);
    let diff;
    try {
      diff = await loadDiff(this.review.sources, this.bb.log, environment, target, patterns);
    } catch (error) {
      if (error instanceof ReviewUnavailable) throw new ReviewError(error.message, "diff_unavailable");
      throw error;
    }
    const file = diff.files.find((entry) => entry.path === path);
    if (file === undefined) {
      const shown = diff.files.slice(0, 40).map((entry) => entry.path);
      throw new ReviewError(`${path} is not in the diff under review. Files in it: ${shown.join(", ")}${diff.files.length > shown.length ? ", …" : ""}.`, "file_not_in_diff");
    }
    if (file.patch !== null) return { patch: file.patch, revision: file.revision };
    let loaded;
    try {
      [loaded] = await loadPatches(this.review.git, environment, target, [file]);
    } catch (error) {
      if (error instanceof ReviewUnavailable) throw new ReviewError(error.message, "diff_unavailable");
      throw error;
    }
    if (loaded === undefined) throw new ReviewError(`bb gave no diff for ${path}.`, "file_not_in_diff");
    return { patch: loaded.patch, revision: file.revision };
  }

  private openThreads(sessionId: string, ids: readonly string[]): ReviewThread[] {
    const all = new Map(this.store.threads(sessionId).map((row) => [row.id, row]));
    const chosen: ReviewThread[] = [];
    for (const id of new Set(ids)) {
      const row = all.get(id);
      if (row === undefined) throw new ReviewError(`No comment thread ${id} in this review.`, "unknown_thread");
      if (row.status !== "open") throw new ReviewError(`Comment thread ${id} is ${row.status}; reopen it to send it.`, "not_open");
      chosen.push(row);
    }
    if (chosen.length === 0) throw new ReviewError("Pick at least one open comment to send.", "nothing_to_send");
    return chosen;
  }

  /**
   * Starts a run's thread, in an order that leaves no gap a Clear review, a Close or the run's own
   * first call could fall into:
   *
   * 1. Gives up if the view was cleared since the request came in (`clears`).
   * 2. Writes the run's row, and the sends of the comment threads it may answer (`grants`), before
   *    anything awaits bb. Until bb names its thread, those sends point at `pendingRunThread`.
   * 3. Reads what the start needs (workspace, parent, settings, execution, baseline), then stops
   *    there if the run was closed meanwhile.
   * 4. Asks bb for the thread. The thread may call a tool, run the CLI or end a turn before bb's answer
   *    arrives: `bindIfPending` then binds it by its metadata, which bb stamped as this plugin's.
   *    Binding moves the run's sends to it, so its rights exist before its first prompt can be acted
   *    on. A run closed while bb started it has its thread archived at once.
   *
   * A thread bb refuses to start, or a start that fails before that, leaves a failed run that says
   * why, with its sends taken back.
   */
  private async spawn(input: {
    sessionId: string;
    environmentId: string;
    /** The thread under review; the run's thread is made its child when it works in the same workspace. */
    parentThreadId: string | null;
    kind: Run["kind"];
    reviewThreadId: string | null;
    focus: string | null;
    execution: Execution | (() => Promise<Execution>);
    /** Leave the reasoning level to the provider's default (a question to the reviewer has no picker). */
    reasoningFromProvider?: boolean;
    title: string;
    prompt: string;
    baseline: () => Promise<Fingerprint | null>;
    /** Comment threads the run is sent, to answer. */
    grants?: { reviewThreadIds: readonly string[]; note: string };
    /** The view's clear count when the request came in. */
    clears: number;
  }): Promise<Run> {
    if (this.clearCount(input.sessionId) !== input.clears) {
      throw new ReviewError("The review was cleared while this was being set up; nothing was started.", "cleared");
    }
    const id = newId();
    const known = typeof input.execution === "function" ? null : input.execution;
    this.store.createRun({
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      bbThreadId: null,
      reviewThreadId: input.reviewThreadId,
      focus: input.focus,
      providerId: known?.providerId ?? "",
      model: known === null || known.model === "" ? null : known.model,
      status: "running",
      baseline: null,
      parentThreadId: null,
    });
    let grant: RecordedSend | null = null;
    if (input.grants !== undefined) {
      grant = this.store.recordSend(input.sessionId, pendingRunThread(id), input.grants.reviewThreadIds, input.grants.note);
    }
    try {
      const environment = await this.bb.sdk.environments.get({ environmentId: input.environmentId });
      const parentThreadId = await this.parentIn(input.parentThreadId, input.environmentId);
      const execution = known ?? (await (input.execution as () => Promise<Execution>)());
      const permissionMode = spawnPermissionMode(
        runPermissionMode((await this.settings()).aiPermissionMode),
        await this.providerPermissionModes(input.environmentId, execution.providerId),
      );
      const baseline = await input.baseline();
      this.store.prepareRun(id, {
        parentThreadId,
        baseline: baseline === null ? null : JSON.stringify(baseline),
        providerId: execution.providerId,
        model: execution.model === "" ? null : execution.model,
      });
      if (this.store.run(id)?.status === "closed") {
        // Cancelled before bb was asked: no thread will ever take its comments, so they go back to
        // whoever had them (Clear review already deleted them, which leaves nothing to undo).
        if (grant !== null) this.store.dropSend(grant);
        this.review.publishSession(input.sessionId);
        return publicRun(this.store.run(id)!);
      }
      const thread = await this.bb.sdk.threads.spawn({
        projectId: environment.projectId,
        title: input.title,
        prompt: input.prompt,
        environment: { type: "reuse", environmentId: input.environmentId },
        providerId: execution.providerId,
        ...(execution.model === "" ? {} : { model: execution.model }),
        ...(input.reasoningFromProvider === true ? {} : { reasoningLevel: execution.reasoningLevel }),
        ...(execution.serviceTier === undefined ? {} : { serviceTier: execution.serviceTier }),
        permissionMode,
        ...(parentThreadId === null ? {} : { parentThreadId }),
        pluginMetadata: { [RUN_METADATA_KEY]: id },
      });
      // Already bound if the thread called in first; binding again is a no-op.
      this.store.bindRun(id, thread.id);
      // Closed (Close, Clear review) while bb was starting it: that path had no thread to archive.
      if (this.store.run(id)?.status === "closed") await this.archive({ id, threadId: thread.id });
    } catch (error) {
      if (grant !== null) this.store.dropSend(grant);
      this.store.finishRun(id, "failed", `Could not start the thread: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    this.review.publishSession(input.sessionId);
    return publicRun(this.store.run(id)!);
  }

  /**
   * The startup handshake for a thread that calls in (a tool, the CLI, a turn's end) before `spawn`
   * has recorded it: if bb stamped it as started by this plugin (`originPluginId`, which bb sets at
   * creation and nothing can change) and its metadata names a run still waiting for its thread, the
   * thread is that run's from now on. The metadata alone proves nothing (any client can write it);
   * the origin and a still-unbound run with that random id do.
   */
  async bindIfPending(threadId: string | undefined): Promise<void> {
    if (threadId === undefined || !this.store.hasUnboundRuns() || this.store.isRunThread(threadId)) return;
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (thread.originPluginId !== this.bb.pluginId) return;
      const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId });
      const runId = metadata[RUN_METADATA_KEY];
      if (typeof runId === "string" && /^[0-9a-f]{12}$/.test(runId) && this.store.bindRun(runId, threadId)) {
        this.bb.log.debug(`Bound thread ${threadId} to run ${runId} before bb answered its start.`);
      }
    } catch (error) {
      this.bb.log.debug(`Could not check whether ${threadId} is a run starting up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The parent a run's thread gets: the thread under review, when it still works in the reviewed
   * workspace; otherwise none (the run is still started, at the root of the sidebar).
   */
  private async parentIn(threadId: string | null, environmentId: string): Promise<string | null> {
    if (threadId === null) return null;
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (thread.environmentId === environmentId) return thread.id;
      this.bb.log.info(`Thread ${threadId} works in another workspace; its review run starts without a parent.`);
    } catch (error) {
      this.bb.log.warn(`Could not read thread ${threadId} to parent a review run: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  /** The workspace's uncommitted changes, one fingerprint per file. */
  private async fingerprint(environmentId: string): Promise<Fingerprint> {
    return (await uncommittedFingerprint(this.review.git, environmentId)).prints;
  }
}

/**
 * A model's default reasoning as a level bb's spawn takes. Providers name their own efforts; one
 * bb's spawn does not know runs at "medium".
 */
export function reasoningLevel(effort: string): Execution["reasoningLevel"] {
  const parsed = reasoningLevelSchema.safeParse(effort);
  return parsed.success ? parsed.data : "medium";
}

/** Runs that only read and comment: they are watched for edits, and may open comment threads. */
export function readsOnly(kind: Run["kind"]): boolean {
  return kind === "review" || kind === "summary" || kind === "explain";
}

/** Files whose uncommitted change differs between two fingerprints, sorted. */
export function changedFiles(before: Fingerprint, after: Fingerprint): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

/** "1-4, 11-12" for a set of line numbers. */
export function ranges(lines: readonly number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const line of sorted) {
    if (start !== undefined && previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    if (start !== undefined && previous !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  if (start !== undefined && previous !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(", ");
}
