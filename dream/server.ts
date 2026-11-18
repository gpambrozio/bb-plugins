// Dream — the server entry.
//
// Defines the settings (the schedule ships off), keeps the machine and model choices, and binds the
// dream service (server/service.ts) to bb: projects and threads through `bb.sdk`, the dream machine's
// files through the host entry (host.ts), push notifications through bb's Push notifications plugin.
// See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { DEFAULT_CHOICES, DREAM_CHANGED, ChoicesSchema, type Choices } from "./shared/contract-types";
import { rpcContract } from "./shared/contract";
import { DEFAULT_THRESHOLDS } from "./shared/gate";
import { hostContract } from "./shared/host-contract";
import { isClock } from "./shared/window";
import { dreamCli } from "./server/cli";
import { createDreamService, type DreamConfig, type ThreadState } from "./server/service";

export type { RpcContract } from "./shared/contract";

const CHOICES_KEY = "choices";
/** Marks a dream's own thread, so `agents.configure` gives it nothing and other code can tell it apart. */
export const RUN_METADATA_KEY = "dreamRunId";
const OPERATOR_SKILL = "dream-plugin";

/** bb's built-in Push notifications plugin, and its send method (bb 0.48.1). */
const PUSH_PLUGIN_ID = "push-notifications";
const PushSentSchema = z.object({ ok: z.literal(true), channels: z.array(z.string()) });

const clock = z.string().refine(isClock, "Use 24-hour HH:MM, such as 01:00.");
const positive = z.number().int().min(1);
const nonNegative = z.number().min(0);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && (error as { status?: unknown }).status === 404;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    scheduleEnabled: {
      type: "boolean",
      label: "Dream on a schedule",
      description:
        "Off until you turn it on. Every night inside the window below, Dream consolidates the most overdue project's memory, then the next, one at a time. A project's first dream is a dry run you apply or discard.",
      default: false,
    },
    windowStart: { type: "string", label: "Window starts", description: "24-hour time on the bb server's clock.", experimental_schema: clock, default: "01:00" },
    windowEnd: { type: "string", label: "Window ends", description: "No dream starts after this; one that is running finishes.", experimental_schema: clock, default: "06:00" },
    minHours: { type: "number", label: "Hours between dreams", description: "At least this long since a project's last dream.", experimental_schema: nonNegative, default: DEFAULT_THRESHOLDS.minHours },
    minSessions: { type: "number", label: "Sessions since the last dream", description: "Claude Code sessions in the project, its worktrees included.", experimental_schema: positive, default: DEFAULT_THRESHOLDS.minSessions },
    minDays: { type: "number", label: "On at least this many days", description: "So a burst of sessions on one day does not trigger a dream.", experimental_schema: positive, default: DEFAULT_THRESHOLDS.minDays },
    quietMinutes: {
      type: "number",
      label: "Quiet minutes",
      description: "Skip a project whose memory changed, or that had a session, this recently: someone is working in it.",
      experimental_schema: nonNegative,
      default: DEFAULT_THRESHOLDS.quietMinutes,
    },
    backupsToKeep: { type: "number", label: "Backups to keep per project", description: "A backup of the memory folder is taken before every change.", experimental_schema: positive, default: 20 },
    notify: {
      type: "boolean",
      label: "Push a notification after a dream that changed files",
      description: "One notification naming the project and how many memory files changed, through bb's Push notifications. Nothing is sent when nothing changed.",
      default: true,
    },
    alwaysDryRun: {
      type: "boolean",
      label: "Always dry run",
      description:
        "Every dream, scheduled or by hand, is a dry run you apply or discard, even after a project's first one was applied. Off: only a project's first dream is a dry run, and later ones edit its memory in place.",
      default: false,
    },
  });

  async function choices(): Promise<Choices> {
    const stored = ChoicesSchema.safeParse(await bb.storage.kv.get(CHOICES_KEY));
    return stored.success ? stored.data : DEFAULT_CHOICES;
  }

  async function config(): Promise<DreamConfig> {
    const values = await settings.get();
    return {
      scheduleEnabled: values.scheduleEnabled,
      windowStart: values.windowStart,
      windowEnd: values.windowEnd,
      thresholds: { minHours: values.minHours, minSessions: values.minSessions, minDays: values.minDays, quietMinutes: values.quietMinutes },
      backupsToKeep: values.backupsToKeep,
      notify: values.notify,
      alwaysDryRun: values.alwaysDryRun,
      choices: await choices(),
    };
  }

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const publish = () => bb.realtime.publish(DREAM_CHANGED, { at: Date.now() });

  /** A dream thread's state once `turns` turns (the startup check, then the dream) should have completed. */
  async function threadState(threadId: string, turns: number): Promise<ThreadState> {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch (error) {
      if (isNotFound(error)) return { kind: "gone" };
      throw error;
    }
    if (thread.deletedAt !== null) return { kind: "gone" };
    if (thread.status === "error") return { kind: "failed", error: "The dream thread failed." };
    const pending = await bb.sdk.threads.interactions.list({ threadId });
    if (pending.length > 0) return { kind: "asking" };
    if (thread.status !== "idle") return { kind: "running" };
    const completed = await bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "10" });
    if (completed.length < turns) return { kind: "running" };
    // An interrupted or failed turn is not a turn that finished.
    const last = completed[0];
    const status = last.type === "turn/completed" ? last.data.status : undefined;
    return status === undefined || status === "completed" ? { kind: "finished" } : { kind: "failed", error: `The dream's turn ended ${String(status)}.` };
  }

  /** Whether bb says the thread is not running: idle, failed, or gone. */
  async function threadStopped(threadId: string): Promise<boolean> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.deletedAt !== null || thread.status === "idle" || thread.status === "error";
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
  }

  const service = createDreamService({
    now: () => Date.now(),
    sleep,
    log: bb.log,
    config,
    saveChoices: (next) => bb.storage.kv.set(CHOICES_KEY, next),
    primaryHostId: async () => (await bb.sdk.system.config()).primaryHostId,
    hosts: async () =>
      (await bb.sdk.hosts.list())
        .filter((entry) => entry.lifecycle.phase !== "destroyed" && entry.lifecycle.phase !== "removing")
        .map((entry) => ({ id: entry.id, name: entry.name, connected: entry.status === "connected" && entry.lifecycle.phase === "active" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    projects: async () => (await bb.sdk.projects.list()).map((project) => ({ id: project.id, name: project.name, kind: project.kind, sources: project.sources })),
    threadProject: async (threadId) => {
      try {
        return (await bb.sdk.threads.get({ threadId })).projectId;
      } catch (error) {
        return isNotFound(error) ? null : undefined;
      }
    },
    host: {
      scan: (hostId) => host.call("scan", {}, { hostId }),
      status: (hostId, input) => host.call("status", input, { hostId }),
      prepare: (hostId, input) => host.call("prepare", input, { hostId }),
      checkCanary: (hostId, input) => host.call("checkCanary", input, { hostId }),
      finish: (hostId, input) => host.call("finish", input, { hostId }),
      apply: (hostId, input) => host.call("apply", input, { hostId }),
      discard: (hostId, input) => host.call("discard", input, { hostId }),
      restore: (hostId, input) => host.call("restore", input, { hostId }),
      backups: (hostId, input) => host.call("backups", input, { hostId }),
      proposalDiff: (hostId, input) => host.call("proposalDiff", input, { hostId }),
      activeRuns: (hostId) => host.call("activeRuns", {}, { hostId }),
      waiting: (hostId) => host.call("waiting", {}, { hostId }),
    },
    threads: {
      spawn: async (request) => {
        const thread = await bb.sdk.threads.spawn({
          projectId: request.projectId,
          title: `Dream: ${request.projectName}`,
          prompt: request.prompt,
          providerId: "claude-code",
          model: request.model,
          reasoningLevel: request.reasoningLevel,
          permissionMode: "accept-edits",
          visibility: "hidden",
          environment: { type: "host", hostId: request.hostId, workspace: { type: "unmanaged", path: request.workspace } },
          pluginMetadata: { [RUN_METADATA_KEY]: request.runId },
        });
        return thread.id;
      },
      send: async (threadId, text) => {
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      },
      writeErrors: async (threadId, file) => {
        // The canary is the thread's first turn, so its items are among the first events.
        const rows = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "asc", limit: "100" });
        const errors: string[] = [];
        for (const row of rows) {
          const item = (row as { data?: { item?: { type?: unknown; status?: unknown; error?: unknown; changes?: unknown } } }).data?.item;
          if (item?.type !== "fileChange" || item.status !== "failed" || typeof item.error !== "string") continue;
          const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown }>) : [];
          if (changes.some((change) => change.path === file)) errors.push(item.error);
        }
        return errors;
      },
      state: threadState,
      output: async (threadId) => (await bb.sdk.threads.output({ threadId })).output,
      stop: async (threadId) => {
        await bb.sdk.threads.stop({ threadId });
      },
      stopped: threadStopped,
      archive: async (threadId) => {
        await bb.sdk.threads.archive({ threadId });
      },
      listOpen: async () => (await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false })).map((thread) => thread.id),
    },
    kv: bb.storage.kv,
    // Feature-detected: with Push notifications off, or on a bb without it, this throws and is logged.
    notify: async (title, body) => {
      const sent = await bb.sdk.plugins.callRpc({ pluginId: PUSH_PLUGIN_ID, method: "notifications.send", input: { title, body }, outputSchema: PushSentSchema });
      if (sent.channels.length === 0) bb.log.info(`No notification channel is on for "${title}".`);
    },
    publish,
  });
  bb.onDispose(() => service.dispose());

  settings.onChange(() => publish());

  bb.rpc.register(rpcContract, {
    overview: () => service.overview(),
    history: ({ limit, projectId }) => service.history.list(limit ?? 50, projectId),
    setSwitch: async ({ projectId, enabled }) => {
      await service.setSwitch(projectId, enabled);
      return {};
    },
    setChoices: (changes) => service.setChoices(changes),
    run: async ({ projectId, dryRun }) => {
      const { record } = await service.begin(projectId, { mode: dryRun ? "dry-run" : null, manual: true, trigger: "manual" });
      return { runId: record.runId, threadId: record.threadId ?? "", mode: record.mode, projectName: record.projectName };
    },
    stop: async () => ({ stopped: await service.stopActive() }),
    apply: ({ projectId, stamp }) => service.apply(projectId, stamp),
    discard: ({ projectId, stamp }) => service.discard(projectId, stamp),
    restore: ({ projectId, stamp }) => service.restore(projectId, stamp),
    proposal: ({ projectId, stamp }) => service.proposal(projectId, stamp),
    waiting: () => service.waiting(),
    backups: async ({ projectId }) => {
      const result = await service.backups(projectId);
      return { backups: result.backups, proposals: result.proposals.filter((proposal) => proposal !== null) };
    },
  });

  bb.cli.register(dreamCli(service));

  // A dream thread gets no plugin tools and no skills; every other thread gets the operator skill.
  bb.agents.configure((context) => {
    const isDream = typeof context.pluginMetadata[RUN_METADATA_KEY] === "string";
    return { tools: [], skills: isDream ? [] : [OPERATOR_SKILL] };
  });

  bb.background.service("sweep", {
    start: (signal) => service.loop(signal),
  });
}
