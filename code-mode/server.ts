// code-mode — the server entry. It answers bb's dispatch hook and Claude Code's environment resolver
// (server/policy.ts), keeps each thread's sticky choice on the thread (server/records.ts), the owner's
// per-project and per-machine switches in storage (server/config-store.ts), and asks each machine's
// host entry to write the wrapper there (server/wrappers.ts). The app reads all of it through
// shared/contract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { CONFIG_TAG, HOSTS_TAG, rpcContract, threadTag } from "./shared/contract";
import { hostContract } from "./shared/host-contract";
import { SPAWNED_LABELS, SPAWNED_OPTIONS, SPAWNED_SETTING, spawnedRule, type SpawnedRule } from "./shared/settings";
import { createConfigStore } from "./server/config-store";
import { MACHINE_CHECKS_SERVICE, runMachineChecks } from "./server/machine-checks";
import { CLAUDE_CODE, createPolicy } from "./server/policy";
import { createRecords } from "./server/records";
import { createWrappers } from "./server/wrappers";


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


  const config = createConfigStore({
    kv: bb.storage.kv,
    projectNames: async (projectIds) => {
      const wanted = new Set(projectIds);
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return new Map(projects.filter((project) => wanted.has(project.id)).map((project) => [project.id, project.name]));
    },
    changed: () => bb.rpc.experimental_invalidate([CONFIG_TAG]),
    log: bb.log,
  });

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
    changed: () => bb.rpc.experimental_invalidate([HOSTS_TAG]),
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
    "config.setProjectName": ({ name, on }) => config.setProjectNames([name], on),
    "config.setHost": async ({ hostId, on }) => {
      const updated = await config.setHosts([hostId], on);
      if (on) void wrappers.check(hostId);
      return updated;
    },
    "config.setProjectNames": ({ names, on }) => config.setProjectNames(names, on),
    "config.setHosts": async ({ hostIds, on }) => {
      const updated = await config.setHosts(hostIds, on);
      if (on) for (const hostId of hostIds) void wrappers.check(hostId);
      return updated;
    },
    "hosts.status": () => wrappers.statuses(),
    "hosts.check": async ({ hostId }) => {
      const result = await wrappers.check(hostId);
      return result.ok ? { ok: true, message: `Ready: ${result.path}` } : { ok: false, message: result.reason };
    },
  });

  // Writes the wrapper on every machine that is on, once loading is done (server/machine-checks.ts).
  bb.background.service(MACHINE_CHECKS_SERVICE, {
    start: (signal) =>
      runMachineChecks(signal, { config: () => config.get(), check: (hostId) => wrappers.check(hostId), isReady: (hostId) => wrappers.isReady(hostId), log: bb.log }),
  });
}
