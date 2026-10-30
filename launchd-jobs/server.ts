// launchd-jobs — the server entry.
//
// Holds no jobs and no timers of its own for them: launchd is the scheduler and
// the plists are the store, on whichever Mac the panel is looking at. This file
// forwards each call to that Mac's host entry (host.ts), keeps the failing
// count the sidebar shows (server/health.ts), and relays log changes to the
// app while a log is being followed, and sends the opt-in push notification
// when a job starts failing (server/failure-push.ts). See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HEALTH_CHANGED, LOG_CHANGED, type Health } from "./shared/channels";
import { rpcContract } from "./shared/contract";
import { hostContract, hostSignals } from "./shared/host-contract";
import { createFailurePush } from "./server/failure-push";
import { createHealthMonitor } from "./server/health";

export type { RpcContract } from "./shared/contract";

/** How often the failing count is re-taken. */
const HEALTH_POLL_MS = 60_000;
const WATCHED_HOSTS_KEY = "watched-hosts";
/** The `hostId/id` of every failing job the push has already accounted for. */
const NOTIFIED_FAILURES_KEY = "notified-failures";

/** bb's built-in Push notifications plugin, and its send method (bb 0.48.1). */
const PUSH_PLUGIN_ID = "push-notifications";
const PUSH_SEND_METHOD = "notifications.send";
const PushSentSchema = z.object({ ok: z.literal(true), channels: z.array(z.string()) });

/** Resolves after `ms`, or as soon as `signal` aborts. */
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

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  const settings = bb.settings.define({
    notifyOnFailure: {
      type: "boolean",
      label: "Push a notification when a job starts failing",
      description:
        "One notification when a job's latest run fails, and nothing more until it runs successfully again or you open it. Sent through bb's Push notifications (bb 0.48.1 or newer); jobs already failing when you turn this on are not announced.",
      default: false,
    },
  });

  const failurePush = createFailurePush({
    enabled: async () => (await settings.get()).notifyOnFailure,
    load: async () => (await bb.storage.kv.get<string[]>(NOTIFIED_FAILURES_KEY)) ?? undefined,
    save: (keys) => bb.storage.kv.set(NOTIFIED_FAILURES_KEY, keys),
    // Feature-detected: on a bb before 0.48.1, or with Push notifications off, this throws and is logged once.
    send: async ({ title, body }) => {
      const sent = await bb.sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN_ID,
        method: PUSH_SEND_METHOD,
        input: { title, body },
        outputSchema: PushSentSchema,
      });
      if (sent.channels.length === 0) bb.log.debug(`no notification channel is on for "${title}"`);
    },
    warn: (message) => bb.log.warn(message),
  });
  bb.onDispose(() => failurePush.dispose());

  async function knownHosts(): Promise<Map<string, { name: string; connected: boolean }>> {
    const hosts = await bb.sdk.hosts.list();
    return new Map(
      hosts
        .filter((entry) => entry.lifecycle.phase !== "destroyed" && entry.lifecycle.phase !== "removing")
        .map((entry) => [
          entry.id,
          { name: entry.name, connected: entry.status === "connected" && entry.lifecycle.phase === "active" },
        ]),
    );
  }

  const health = createHealthMonitor({
    primaryHostId: async () => (await bb.sdk.system.config()).primaryHostId,
    knownHosts,
    hostHealth: (hostId) => host.call("health", {}, { hostId }),
    loadWatched: async () => (await bb.storage.kv.get<string[]>(WATCHED_HOSTS_KEY)) ?? [],
    saveWatched: (hostIds) => bb.storage.kv.set(WATCHED_HOSTS_KEY, hostIds),
    publish: (value: Health) => bb.realtime.publish(HEALTH_CHANGED, value),
    checked: (failing, unanswered) => void failurePush.observe(failing, unanswered),
    now: () => Date.now(),
    warn: (message) => bb.log.warn(message),
  });

  /** Re-counts after something that can change the count, without making the caller wait or fail on it. */
  function recount(): void {
    void health.refresh().catch((error: unknown) => bb.log.warn(`could not re-count failing jobs: ${String(error)}`));
  }

  bb.onDispose(
    host.experimental_onSignal("logChanged", ({ hostId, payload }) => {
      bb.log.debug(`log of ${payload.id} changed on ${hostId}`);
      bb.realtime.publish(LOG_CHANGED, { hostId, id: payload.id });
    }),
  );

  bb.rpc.register(rpcContract, {
    hosts: async () => {
      const [config, known] = await Promise.all([bb.sdk.system.config(), knownHosts()]);
      return {
        primaryHostId: config.primaryHostId,
        hosts: [...known]
          .filter(([, host]) => host.connected)
          .map(([id, host]) => ({ id, name: host.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    list: async ({ hostId }) => {
      const result = await host.call("list", {}, { hostId });
      if (result.supported) await health.noteJobCount(hostId, result.jobs.length);
      return result;
    },
    create: async ({ hostId, spec }) => {
      const job = await host.call("create", spec, { hostId });
      await health.noteJobCount(hostId, 1);
      return job;
    },
    update: ({ hostId, id, spec }) => host.call("update", { id, spec }, { hostId }),
    delete: async ({ hostId, id }) => {
      const result = await host.call("delete", { id }, { hostId });
      // Its failure went with it; the sidebar should not keep counting it.
      recount();
      return result;
    },
    run: ({ hostId, id }) => host.call("run", { id }, { hostId }),
    setEnabled: ({ hostId, id, enabled }) => host.call("setEnabled", { id, enabled }, { hostId }),
    log: ({ hostId, id, from }) => host.call("log", from === undefined ? { id } : { id, from }, { hostId }),
    follow: ({ hostId, id }) => host.call("follow", { id }, { hostId }),
    unfollow: ({ hostId, id }) => host.call("unfollow", { id }, { hostId }),
    health: async ({ refresh }) => (refresh || health.current().checkedAt === null ? health.refresh() : health.current()),
    acknowledge: async ({ hostId, id }) => {
      const result = await host.call("acknowledge", { id }, { hostId });
      recount();
      return result;
    },
  });

  // launchd fires the jobs; this only re-reads how their last runs ended.
  bb.background.service("health", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await health.refresh();
        } catch (error) {
          bb.log.warn(`could not count failing jobs: ${String(error)}`);
        }
        await sleep(HEALTH_POLL_MS, signal);
      }
    },
  });
}
