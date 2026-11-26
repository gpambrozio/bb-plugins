// The two places bb asks the plugin about a Claude Code thread:
//
// - `dispatchHook`, bb's `message.dispatch` hook, before a message reaches the provider. On a thread's
//   first message it records the thread's choice (server/decide.ts); on every message to a Code Mode
//   thread it refuses a model that can't run Code Mode.
// - `resolveEnv`, the resolver behind `bb.providers.experimental_contributeEnv("claude-code")`, before
//   every start, resume, fork and turn. For a Code Mode thread it hands bb the wrapper's launcher as
//   BB_CLAUDE_CODE_EXECUTABLE; for any other thread, nothing.
//
// The resolver must give a thread the same answer every time, or its session can't resume. A thread
// whose first message skipped the hook ("Send now" on a queued message skips every hook) is decided
// here instead, by the defaults. A thread that existed before the plugin, or that already ran a turn
// without it, is left alone: it gets nothing, now and later.
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
  records: Records;
  config: ConfigStore;
  spawnedRule(): Promise<SpawnedRule>;
  getThread(threadId: string): Promise<ThreadFacts | null>;
  /** Whether the thread has finished a turn already. */
  hasRun(threadId: string): Promise<boolean>;
  /** The project's name, which its default is keyed by; null when bb does not know the project. */
  projectName(projectId: string): Promise<string | null>;
  /** When this plugin was first loaded in this bb (epoch ms). */
  installedAt(): Promise<number>;
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
    const isFork = forkSource(ctx.thread) !== null;
    // Only a thread's first message decides; any other thread without a record is the resolver's.
    if (!isFork && (ctx.attempt !== "start-turn" || ctx.thread.status !== "pending")) return PROCEED;

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

  /** The record for a thread bb starts without one: inherited, by the defaults, or none at all. */
  function decideAtStart(threadId: string, projectId: string | null, hostId: string) {
    return records.decideOnce(threadId, async () => {
      const thread = await deps.getThread(threadId);
      if (!thread) return { record: null };
      if (!forkSource(thread) && (thread.createdAt < (await deps.installedAt()) || (await deps.hasRun(threadId)))) {
        // It ran, or was made, without the plugin: its session is not Code Mode, so it never will be.
        return { record: null };
      }
      const starter = thread.parentThreadId;
      const known = await facts({
        thread,
        projectName: await deps.projectName(projectId ?? thread.projectId),
        explicit: null,
        starter,
        spawned: starter !== null || thread.originPluginId !== null,
        hostId,
        hostName: null,
        model: null,
      });
      const decision = await requireWrapper(decide(known), known, () => deps.wrappers.readiness(hostId));
      // With no explicit choice, decide() never refuses.
      if (decision.kind === "reject") return { record: null };
      deps.log.info(`Thread ${threadId} started without a dispatch decision: Code Mode ${decision.codeMode} (${decision.reason}).`);
      return { record: records.make(decision.codeMode, decision.reason), store: true };
    });
  }

  async function resolveEnv(ctx: ExperimentalPluginProviderEnvContext): Promise<readonly ExperimentalPluginProviderEnvEntry[]> {
    // Model listing and other provider processes that serve no thread are never touched.
    if (ctx.threadId === null) return [];
    try {
      const record = await decideAtStart(ctx.threadId, ctx.projectId, ctx.hostId);
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
