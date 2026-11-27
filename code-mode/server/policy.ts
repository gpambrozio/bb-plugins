// The two places bb asks the plugin about a Claude Code thread:
//
// - `dispatchHook`, bb's `message.dispatch` hook, before a message reaches the provider. On a thread's
//   first message it records the thread's choice (server/decide.ts); on every message to a Code Mode
//   thread it refuses a model that can't run Code Mode.
// - `resolveEnv`, the resolver behind `bb.providers.experimental_contributeEnv("claude-code")`, before
//   every start, resume, fork and turn. For a Code Mode thread it hands bb the wrapper's launcher as
//   BB_CLAUDE_CODE_EXECUTABLE; for any other thread, nothing.
//
// The resolver must give a thread the same answer every time, or its session can't resume. Only the
// hook decides a new thread; the resolver decides only a fork (by its source), and leaves any other
// thread without a record alone: it gets nothing, now and later (see decideAtStart).
import type { ExperimentalPluginProviderEnvContext, ExperimentalPluginProviderEnvEntry, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";

import { hostAllowed, projectDefault } from "../shared/config";
import type { CodeModeRecord } from "../shared/record";
import type { SpawnedRule } from "../shared/settings";
import type { ConfigStore } from "./config-store";
import { decide, modelGuard, requireWrapper, type DecisionFacts } from "./decide";
import type { Records } from "./records";
import type { Wrappers } from "./wrappers";

export const CLAUDE_CODE = "claude-code";
export const EXECUTABLE_VARIABLE = "BB_CLAUDE_CODE_EXECUTABLE";

/** The thread fields the policy reads, from `bb.sdk.threads.get`. */
export interface ThreadFacts {
  id: string;
  projectId: string;
  providerId: string;
  createdAt: number;
  originKind: "fork" | null;
  sourceThreadId: string | null;
  parentThreadId: string | null;
  originPluginId: string | null;
}

export interface PolicyDeps {
  pluginId: string;
  /** When this copy of the plugin loaded (epoch ms, bb's clock): see `freshFork`. */
  loadedAt: number;
  records: Records;
  config: ConfigStore;
  spawnedRule(): Promise<SpawnedRule>;
  getThread(threadId: string): Promise<ThreadFacts | null>;
  wrappers: Wrappers;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

/** What "Send in Code Mode" put on the send, or null when it put nothing. */
export function submissionChoice(submission: MessageDispatchHookContext["experimental_submission"], pluginId: string): boolean | null {
  if (submission?.pluginId !== pluginId) return null;
  const data = submission.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const codeMode = (data as Record<string, unknown>).codeMode;
  return typeof codeMode === "boolean" ? codeMode : null;
}

function forkSource(thread: Pick<ThreadFacts, "originKind" | "sourceThreadId">): string | null {
  return thread.originKind === "fork" && thread.sourceThreadId ? thread.sourceThreadId : null;
}

export function createPolicy(deps: PolicyDeps) {
  const { records } = deps;

  /**
   * A fork without a record may take its source's choice only while its session can't have run
   * without the plugin: it was made while this copy was loaded (its every launch has come here, and the
   * first one recorded it), or it is still `pending` (it never ran). A fork made while the plugin was
   * off may already have run with the ordinary tools: it gets nothing, now and later. Its event log
   * can't tell, since a fork's history is a copy of its source's.
   */
  function inheritsFromSource(thread: Pick<ThreadFacts, "originKind" | "sourceThreadId" | "createdAt"> & { status?: string }): boolean {
    return forkSource(thread) !== null && (thread.createdAt >= deps.loadedAt || thread.status === "pending");
  }

  async function facts(args: {
    thread: Pick<ThreadFacts, "originKind" | "sourceThreadId" | "parentThreadId" | "originPluginId">;
    projectName: string | null;
    explicit: boolean | null;
    starter: string | null;
    spawned: boolean;
    hostId: string | null;
    hostName: string | null;
    model: string | null;
  }): Promise<DecisionFacts> {
    const source = forkSource(args.thread);
    const config = await deps.config.get();
    const rule = await deps.spawnedRule();
    let parentRecord: CodeModeRecord | null = null;
    if (!source && args.spawned && rule === "parent" && args.starter) parentRecord = await records.get(args.starter);
    return {
      fork: source ? { sourceRecord: await records.get(source) } : null,
      explicit: args.explicit,
      spawned: args.spawned,
      spawnedRule: rule,
      parentRecord,
      projectDefault: projectDefault(config, args.projectName),
      hostAllowed: hostAllowed(config, args.hostId),
      hostName: args.hostName,
      model: args.model,
    };
  }

  async function dispatchHook(ctx: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
    if (ctx.requestedExecution.providerId !== CLAUDE_CODE) return PROCEED;
    const model = ctx.requestedExecution.model;
    const existing = await records.get(ctx.thread.id);
    if (existing) {
      const refusal = modelGuard(existing, model);
      return refusal ? { action: "reject", message: refusal } : PROCEED;
    }
    // Only a thread's first message decides, or a fork that can't have run without the plugin; any other
    // thread without a record is left alone.
    if (forkSource(ctx.thread) !== null ? !inheritsFromSource(ctx.thread) : ctx.attempt !== "start-turn" || ctx.thread.status !== "pending") return PROCEED;

    const sender = typeof ctx.senderThreadId === "string" && ctx.senderThreadId !== "mixed" ? ctx.senderThreadId : null;
    const starter = ctx.parentThreadId ?? ctx.thread.parentThreadId ?? sender;
    const spawned = starter !== null || ctx.senderThreadId === "mixed" || ctx.thread.originPluginId !== null || ctx.initiator === "agent";
    const hostId = ctx.host?.id ?? null;
    const known = await facts({
      thread: ctx.thread,
      projectName: ctx.project.name,
      explicit: submissionChoice(ctx.experimental_submission, deps.pluginId),
      starter,
      spawned,
      hostId,
      hostName: ctx.host?.name ?? null,
      model,
    });
    // decide() turns Code Mode on only for a machine that is on, so hostId is set when it is asked.
    const decision = await requireWrapper(decide(known), known, () => deps.wrappers.readiness(hostId ?? ""));
    if (decision.kind === "reject") return { action: "reject", message: decision.message };
    const record = await records.decideOnce(ctx.thread.id, async () => ({ record: records.make(decision.codeMode, decision.reason), store: true }));
    deps.log.info(`Thread ${ctx.thread.id}: Code Mode ${record?.codeMode ?? "untouched"} (${record?.reason ?? "no record"}).`);
    const refusal = modelGuard(record, model);
    return refusal ? { action: "reject", message: refusal } : PROCEED;
  }

  /**
   * The record for a thread bb starts without one. A fork made while this copy of the plugin is loaded
   * takes its source's choice, since it resumes the source's session (see `inheritsFromSource`). Any
   * other thread is left alone and gets nothing: its first launch had no recorded choice ("Send now" on
   * a queued first message skips the dispatch hook), or it started while the plugin was off. The
   * resolver can't tell whether its session has already started, nor on which model, so asserting Code
   * Mode for it could record a session that never ran in Code Mode.
   */
  function decideAtStart(threadId: string) {
    return records.decideOnce(threadId, async () => {
      const thread = await deps.getThread(threadId);
      const source = thread && inheritsFromSource(thread) ? forkSource(thread) : null;
      if (!source) return { record: null };
      const sourceRecord = await records.get(source);
      const codeMode = sourceRecord?.codeMode === "on" ? "on" : "off";
      deps.log.info(`Fork ${threadId} started without a dispatch decision: Code Mode ${codeMode}, as its source.`);
      return { record: records.make(codeMode, codeMode === "on" ? "forked from a Code Mode thread" : "forked from a thread without Code Mode"), store: true };
    });
  }

  async function resolveEnv(ctx: ExperimentalPluginProviderEnvContext): Promise<readonly ExperimentalPluginProviderEnvEntry[]> {
    // Model listing and other provider processes that serve no thread are never touched.
    if (ctx.threadId === null) return [];
    try {
      const record = await decideAtStart(ctx.threadId);
      if (record?.codeMode !== "on") return [];
      const path = await deps.wrappers.pathFor(ctx.hostId);
      if (path === null) {
        deps.log.error(`Thread ${ctx.threadId} is in Code Mode, but the wrapper is not ready on ${ctx.hostId}; it starts without Code Mode, and a Code Mode session can't resume.`);
        return [];
      }
      return [{ name: EXECUTABLE_VARIABLE, value: path, reason: "Code Mode was chosen for this thread" }];
    } catch (error) {
      deps.log.error(`Could not resolve Code Mode for thread ${ctx.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  return { dispatchHook, resolveEnv };
}
