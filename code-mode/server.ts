// code-mode — the server entry. It answers bb's dispatch hook and Claude Code's environment resolver
// (server/policy.ts), keeps each thread's sticky choice on the thread (server/records.ts), the owner's
// per-project and per-machine switches in storage (server/config-store.ts), and asks each machine's
// host entry to write the wrapper there (server/wrappers.ts). The app reads all of it through
// shared/contract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { CONFIG_TAG, rpcContract, threadTag } from "./shared/contract";
import { hostContract } from "./shared/host-contract";
import { SPAWNED_LABELS, SPAWNED_OPTIONS, SPAWNED_SETTING, spawnedRule, type SpawnedRule } from "./shared/settings";
import { createConfigStore } from "./server/config-store";
import { CLAUDE_CODE, createPolicy } from "./server/policy";
import { createRecords } from "./server/records";
import { createWrappers } from "./server/wrappers";

export const INSTALLED_AT_KEY = "installedAt";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    [SPAWNED_SETTING]: {
      type: "select",
      label: "Threads that agents and plugins start",
      description:
        "Whether a thread started by another thread (a crewmate, a subagent thread) or by a plugin starts in Code Mode. Threads you start follow the project's switch below, or Send in Code Mode.",
      options: [...SPAWNED_OPTIONS],
      experimental_optionLabels: SPAWNED_LABELS,
      default: "project-default",
    },
  });
  let rule: SpawnedRule | null = null;
  settings.onChange((next) => {
    rule = spawnedRule(next[SPAWNED_SETTING]);
  });

  // The first load marks the moment from which new threads are this plugin's to decide.
  let installedAt = await bb.storage.kv.get<number>(INSTALLED_AT_KEY);
  if (typeof installedAt !== "number") {
    installedAt = Date.now();
    await bb.storage.kv.set(INSTALLED_AT_KEY, installedAt);
  }
  const firstLoadedAt = installedAt;

  const config = createConfigStore({ kv: bb.storage.kv, changed: () => bb.rpc.experimental_invalidate([CONFIG_TAG]), log: bb.log });

  const records = createRecords({
    read: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
    readMany: async (threadIds) => {
      const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds });
      return new Map(threads.map((row) => [row.threadId, row.metadata]));
    },
    write: async (threadId, record) => {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: { codeMode: record } });
    },
    changed: (threadId) => bb.rpc.experimental_invalidate([threadTag(threadId)]),
    now: () => Date.now(),
    log: bb.log,
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const wrappers = createWrappers({
    install: (hostId) => host.call("install", {}, { hostId, timeoutMs: 15_000 }),
    kv: bb.storage.kv,
    log: bb.log,
  });

  const policy = createPolicy({
    pluginId: bb.pluginId,
    records,
    config,
    spawnedRule: async () => (rule ??= spawnedRule((await settings.get())[SPAWNED_SETTING])),
    getThread: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        id: thread.id,
        projectId: thread.projectId,
        providerId: thread.providerId,
        createdAt: thread.createdAt,
        originKind: thread.originKind,
        sourceThreadId: thread.sourceThreadId,
        parentThreadId: thread.parentThreadId,
        originPluginId: thread.originPluginId,
      };
    },
    hasRun: async (threadId) => {
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], limit: "1" });
      return rows.length > 0;
    },
    installedAt: async () => firstLoadedAt,
    wrappers,
    log: bb.log,
  });

  bb.experimental_hooks.on("message.dispatch", policy.dispatchHook);
  bb.providers.experimental_contributeEnv(CLAUDE_CODE, policy.resolveEnv);

  bb.rpc.register(rpcContract, {
    "threads.state": async ({ keys }) => {
      const found = await records.getMany(keys);
      return Object.fromEntries(keys.map((threadId) => [threadId, { state: found.get(threadId)?.codeMode ?? "none" }]));
    },
    "config.get": () => config.get(),
    "config.setProject": ({ projectId, on }) => config.setProject(projectId, on),
    "config.setHost": async ({ hostId, on }) => {
      const updated = await config.setHost(hostId, on);
      if (on) void wrappers.check(hostId);
      return updated;
    },
    "hosts.check": async ({ hostId }) => {
      const result = await wrappers.check(hostId);
      return result.ok ? { ok: true, message: `Ready: ${result.path}` } : { ok: false, message: result.reason };
    },
  });

  // Write the wrapper on every machine that is turned on, so the first Code Mode thread there does
  // not wait for it, and so a launcher naming an old Node is rewritten after a bb update.
  void config
    .get()
    .then((current) => {
      for (const [hostId, on] of Object.entries(current.hosts)) if (on) void wrappers.check(hostId);
    })
    .catch((error: unknown) => bb.log.warn(`Could not read Code Mode's switches on load: ${String(error)}`));
}
