/**
 * AI runs: threads the plugin starts in the reviewed workspace, visible in bb's sidebar so the user can
 * watch, steer and approve them.
 *
 * - **review** — an AI review with an optional focus, leaving comments with the `diff_review_*` tools.
 *   bb cannot make a thread read-only (its least privileged mode is `accept-edits`), so the
 *   workspace's uncommitted changes are fingerprinted before and after, and every file that changed
 *   while it ran is listed on the run.
 * - **mention** — a user comment that @-mentions an agent gets that agent's answer in the thread. A
 *   later mention of the same agent in the same thread goes to the same run thread.
 * - **fix** — "Fix in a new thread": the comments go to a new thread instead of the one under review.
 *
 * Mention and fix runs are sends (`sends` ledger), so the agent answers through the same checks as the
 * thread under review. None is a child of the user's thread, so none posts into it. Each thread
 * carries its run id in the plugin's metadata, which `bb.agents.configure` reads to give it the tools;
 * the tools check the caller against the store, so the metadata grants nothing by itself.
 */
import { createHash } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AGENT_HANDLES, mentionedAgent } from "../shared/mentions";
import { linesText, parsePatchLines } from "../shared/patch-lines";
import {
  describeLocation,
  GENERAL_PATH,
  type Execution,
  type ReviewThread,
  type Run,
  type Severity,
  type Side,
} from "../shared/types";
import { ignorePatterns, loadDiff, loadPatches, ReviewUnavailable } from "./diff";
import { fixPrompt, mentionPrompt, reviewPrompt } from "./run-prompts";
import { publicRun, ReviewError, targetFromKey, type ReviewService, type ReviewSettings } from "./review";
import { newId, type ReviewStore } from "./store";
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

/** The longest run summary kept, in characters. */
const SUMMARY_MAX_CHARS = 4_000;
/** The most files whose patches are fingerprinted one by one; past it, line counts stand in. */
const FINGERPRINT_MAX_FILES = 500;

export interface AgentCommentInput {
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  severity: Severity | null;
  body: string;
}

export class RunService {
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
    return { execution: { providerId, model: model.model, reasoningLevel: model.defaultReasoningEffort }, message: null };
  }

  /** Starts an AI review of a session's view, as a child of `threadId`, the thread under review. */
  async startReview(input: { sessionId: string; threadId: string; focuses: readonly string[]; instructions: string; execution: Execution }): Promise<Run> {
    const session = this.review.requireSession(input.sessionId);
    const target = targetFromKey(session.targetKey);
    const focus = input.focuses.length === 0 ? null : input.focuses.join(", ");
    const baseline = await this.fingerprint(session.environmentId);
    const prompt = reviewPrompt({ target, focus, instructions: input.instructions });
    const title = `Review: ${focus === null ? "changes" : focus}`;
    return this.spawn({ sessionId: session.id, environmentId: session.environmentId, parentThreadId: input.threadId, kind: "review", reviewThreadId: null, focus, execution: input.execution, title, prompt, baseline });
  }

  /** "Fix in a new thread": sends open comment threads to a new thread in the same workspace. */
  async fixInNewThread(input: { sessionId: string; threadId: string; reviewThreadIds: readonly string[]; note: string; execution: Execution }): Promise<{ run: Run; count: number }> {
    const session = this.review.requireSession(input.sessionId);
    const chosen = this.openThreads(session.id, input.reviewThreadIds);
    const target = targetFromKey(session.targetKey);
    const prompt = fixPrompt({ target, threads: chosen, note: input.note });
    const title = `Review fixes: ${chosen.length} comment${chosen.length === 1 ? "" : "s"}`;
    const run = await this.spawn({ sessionId: session.id, environmentId: session.environmentId, parentThreadId: input.threadId, kind: "fix", reviewThreadId: null, focus: null, execution: input.execution, title, prompt, baseline: null });
    if (run.threadId !== null) {
      this.store.recordSend(session.id, run.threadId, chosen.map((row) => row.id), input.note);
      this.review.publishSession(session.id);
    }
    return { run, count: chosen.length };
  }

  /**
   * A user comment that @-mentions an agent: that agent answers in the thread. The run starts in the
   * background; a failure to start shows as a failed run.
   */
  onUserComment(thread: ReviewThread, body: string, viewerThreadId: string | null): void {
    const handle = mentionedAgent(body);
    if (handle === null) return;
    void this.answerMention(thread.id, AGENT_HANDLES[handle], viewerThreadId).catch((error: unknown) => {
      this.bb.log.warn(`Could not answer the mention in ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** `viewerThreadId`: the thread whose Review tab the comment was written in; the run becomes its child. */
  async answerMention(reviewThreadId: string, providerId: string, viewerThreadId: string | null = null): Promise<Run> {
    const thread = this.review.requireThread(reviewThreadId);
    const session = this.review.requireSession(thread.sessionId);
    const prompt = mentionPrompt(targetFromKey(session.targetKey), thread);
    const existing = this.store.mentionRun(thread.id, providerId);
    if (existing !== null && existing.threadId !== null) {
      const send = this.store.recordSend(session.id, existing.threadId, [thread.id], "");
      try {
        await this.bb.sdk.threads.send({ threadId: existing.threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }] });
        this.store.restartRun(existing.id);
        this.review.publishSession(session.id);
        return publicRun(this.store.run(existing.id)!);
      } catch (error) {
        // Its thread is gone (archived or deleted outside the tab): close that run and start anew.
        this.store.dropSend(send.id);
        this.store.closeRun(existing.id);
        this.bb.log.info(`Mention run ${existing.id} could not take a follow-up (${error instanceof Error ? error.message : String(error)}); starting a new one.`);
      }
    }
    const settings = await this.settings();
    const model = providerId === (settings.aiProvider.trim() || "claude-code") && settings.aiModel.trim() !== "" ? settings.aiModel.trim() : "";
    const run = await this.spawn({
      sessionId: session.id,
      environmentId: session.environmentId,
      parentThreadId: viewerThreadId,
      kind: "mention",
      reviewThreadId: thread.id,
      focus: null,
      execution: { providerId, model, reasoningLevel: "medium" },
      reasoningFromProvider: true,
      title: `Review: ${describeLocation(thread)}`,
      prompt,
      baseline: null,
    });
    if (run.threadId !== null) {
      this.store.recordSend(session.id, run.threadId, [thread.id], "");
      this.review.publishSession(session.id);
    }
    return run;
  }

  /** Closes a run: archives its thread and drops it from the tab. */
  async close(runId: string): Promise<void> {
    const run = this.store.run(runId);
    if (run === null) throw new ReviewError(`No run ${runId}.`, "unknown_run");
    if (run.threadId !== null && run.status !== "closed") {
      try {
        await this.bb.sdk.threads.archive({ threadId: run.threadId });
      } catch (error) {
        // The user may have archived or deleted it already; the run closes either way.
        this.bb.log.warn(`Could not archive ${run.threadId} for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.store.closeRun(run.id);
    this.review.publishSession(run.sessionId);
  }

  /** A run thread's turn ended: the run is done (or failed), with the agent's last words as its summary. */
  async turnEnded(threadId: string, lastAssistantText: string | null, failed: boolean): Promise<void> {
    const runs = this.store.runsOfThread(threadId).filter((run) => run.status === "running");
    for (const run of runs) {
      const summary = lastAssistantText === null ? null : lastAssistantText.slice(0, SUMMARY_MAX_CHARS);
      let changed: string[] | null = null;
      if (run.kind === "review" && run.baseline !== null) {
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
    const run = this.store.runsOfThread(callerThreadId).find((row) => row.kind === "review");
    if (run === undefined) throw new ReviewError("Only an AI review run can add comments; answer the threads sent to you instead.", "not_a_review_run");
    const session = this.review.requireSession(run.sessionId);
    const body = input.body.trim() === "" ? null : input.body;
    if (body === null) throw new ReviewError("The comment is empty.", "empty_text");
    let anchorContent: string | null = null;
    if (input.filePath !== GENERAL_PATH) {
      const patch = await this.patchOf(session.environmentId, session.targetKey, input.filePath);
      if (input.startLine > 0) {
        const side = input.side ?? "new";
        const lines = parsePatchLines(patch);
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
    return this.review.createAgentThread({ ...input, sessionId: session.id, anchorContent, body }, authorName);
  }

  private async patchOf(environmentId: string, targetKey: string, path: string): Promise<string> {
    const environment = await this.bb.sdk.environments.get({ environmentId });
    const target = targetFromKey(targetKey);
    const settings = await this.settings();
    const patterns = await ignorePatterns(this.bb.sdk, this.bb.log, environment, settings.ignorePatterns, settings.readIgnoreFiles);
    let diff;
    try {
      diff = await loadDiff(this.bb.sdk, environment, target, patterns);
    } catch (error) {
      if (error instanceof ReviewUnavailable) throw new ReviewError(error.message, "diff_unavailable");
      throw error;
    }
    const file = diff.files.find((entry) => entry.path === path);
    if (file === undefined) {
      const shown = diff.files.slice(0, 40).map((entry) => entry.path);
      throw new ReviewError(`${path} is not in the diff under review. Files in it: ${shown.join(", ")}${diff.files.length > shown.length ? ", …" : ""}.`, "file_not_in_diff");
    }
    if (file.patch !== null) return file.patch;
    const [loaded] = await loadPatches(this.bb.sdk, environment, target, [path]);
    if (loaded === undefined) throw new ReviewError(`bb gave no diff for ${path}.`, "file_not_in_diff");
    return loaded.patch;
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
   * Starts a run's thread. The run row is written first, with the id the thread carries in its
   * metadata; a thread bb refuses to start leaves a failed run that says why.
   */
  private async spawn(input: {
    sessionId: string;
    environmentId: string;
    /** The thread under review; the run's thread is made its child when it works in the same workspace. */
    parentThreadId: string | null;
    kind: Run["kind"];
    reviewThreadId: string | null;
    focus: string | null;
    execution: Execution;
    /** Leave the reasoning level to the provider's default (a mention has no picker). */
    reasoningFromProvider?: boolean;
    title: string;
    prompt: string;
    baseline: Fingerprint | null;
  }): Promise<Run> {
    const environment = await this.bb.sdk.environments.get({ environmentId: input.environmentId });
    const parentThreadId = await this.parentIn(input.parentThreadId, input.environmentId);
    const permissionMode = runPermissionMode((await this.settings()).aiPermissionMode);
    const id = newId();
    const { execution } = input;
    this.store.createRun({
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      bbThreadId: null,
      reviewThreadId: input.reviewThreadId,
      focus: input.focus,
      providerId: execution.providerId,
      model: execution.model === "" ? null : execution.model,
      status: "running",
      baseline: input.baseline === null ? null : JSON.stringify(input.baseline),
      parentThreadId,
    });
    try {
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
      this.store.setRunThread(id, thread.id);
    } catch (error) {
      this.store.finishRun(id, "failed", `Could not start the thread: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    this.review.publishSession(input.sessionId);
    return publicRun(this.store.run(id)!);
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
    const result = await this.bb.sdk.environments.diffFiles({ environmentId, target: "uncommitted" });
    if (result.outcome !== "available") return {};
    const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch.patch]));
    const missing = result.files.filter((file) => !patches.has(file.path) && !file.binary && file.loadMode !== "too_large").map((file) => file.path);
    for (let index = 0; index < Math.min(missing.length, FINGERPRINT_MAX_FILES); index += 50) {
      const batch = await this.bb.sdk.environments.diffPatch({ environmentId, paths: missing.slice(index, index + 50), target: { type: "uncommitted" } });
      if (batch.outcome === "available") for (const patch of batch.patches) patches.set(patch.path, patch.patch);
    }
    const prints: Fingerprint = {};
    for (const file of result.files) {
      const patch = patches.get(file.path);
      prints[file.path] = `${file.changeKind}:${file.additions}:${file.deletions}:${patch === undefined ? "" : createHash("sha256").update(patch).digest("hex")}`;
    }
    return prints;
  }
}

/** Path → a fingerprint of its uncommitted change. */
export type Fingerprint = Record<string, string>;

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
