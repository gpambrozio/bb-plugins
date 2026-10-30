/**
 * The ports (`ports.ts`) over `bb.sdk`. Kept thin on purpose: every decision
 * lives in the modules that use the ports, which are tested against fakes;
 * this file only translates shapes.
 *
 * Call these from handlers and services, never the plugin factory body —
 * `bb.sdk` is for use once the plugin is loaded.
 */
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  BB_LEVEL_DEFAULTS,
  NotificationLevelSchema,
  OwnLevelSchema,
  PUSH_LEVEL_SET_METHOD,
  PUSH_LEVELS_LIST_METHOD,
  PUSH_PLUGIN_ID,
  PUSH_SEND_METHOD,
  type LevelDefaults,
  type OwnLevel,
} from "../shared/push";
import { CHOICE_METADATA_KEY, ownChoiceOf, type ThreadChoice } from "../shared/thread-choice";
import type { EventsPort, LivenessPort, Log, NamesPort, PushPort, ThreadChoicesPort, TimelinePort } from "./ports";
import { lastPrompt } from "./timeline";

/** How long a project's name or an environment's folder is trusted; both change rarely. */
const NAME_TTL_MS = 5 * 60_000;

/** How many recent prompts are read to find the user's last one. */
const PROMPT_HISTORY_LIMIT = "5";

/**
 * The SDK rejects a failed request with its internal `BbHttpError`, which
 * carries the HTTP `status`. The class is not public, so it is recognised by shape.
 */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** A small time-limited cache, so a burst of events does not read the same name per event. */
function cached<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const values = new Map<string, { at: number; value: T }>();
  return async (key) => {
    const hit = values.get(key);
    if (hit !== undefined && Date.now() - hit.at < NAME_TTL_MS) return hit.value;
    const value = await load(key);
    values.set(key, { at: Date.now(), value });
    return value;
  };
}

/** Whether an interaction still waits on the user; one bb no longer knows does not. */
async function interactionPending(sdk: PluginBbSdk, threadId: string, interactionId: string): Promise<boolean> {
  try {
    return (await sdk.threads.interactions.get({ threadId, interactionId })).status === "pending";
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function bbEvents(sdk: PluginBbSdk, log: Log): EventsPort {
  const projectName = cached(async (projectId) => (await sdk.projects.get({ projectId })).name);
  const folder = cached(async (environmentId) => {
    const path = (await sdk.environments.get({ environmentId })).path;
    return path === null || path === "" ? null : basename(path);
  });

  /** Names are niceties: a failed lookup leaves the name out rather than losing the entry. */
  async function orNull<T>(what: string, load: () => Promise<T | null>): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      log.warn(`Could not read ${what}: ${reasonOf(error)}`);
      return null;
    }
  }

  return {
    async context(thread, { withRequest }) {
      const [name, where, request] = await Promise.all([
        orNull(`project ${thread.projectId}`, () => projectName(thread.projectId)),
        thread.environmentId === null
          ? Promise.resolve(null)
          : orNull(`environment ${thread.environmentId}`, () => folder(thread.environmentId ?? "")),
        withRequest
          ? orNull(`thread ${thread.id}'s prompts`, async () =>
              lastPrompt(await sdk.threads.promptHistory({ threadId: thread.id, limit: PROMPT_HISTORY_LIMIT })),
            )
          : Promise.resolve(null),
      ]);
      return { projectName: name, folder: where, lastRequest: request };
    },
    interactionPending: (threadId, interactionId) => interactionPending(sdk, threadId, interactionId),
    async interruptedRecently(threadId, withinMs) {
      const interactions = await sdk.threads.interactions.list({ threadId });
      const since = Date.now() - withinMs;
      return interactions.some(
        (interaction) => interaction.status === "interrupted" && (interaction.resolvedAt ?? interaction.createdAt) >= since,
      );
    },
  };
}

export function bbLiveness(sdk: PluginBbSdk): LivenessPort {
  return {
    async facts(threadId) {
      try {
        const thread = await sdk.threads.get({ threadId });
        if (thread.archivedAt !== null || thread.deletedAt !== null) return { kind: "gone" };
        return {
          kind: "open",
          status: thread.status,
          lastReadAt: thread.lastReadAt,
          latestAttentionAt: thread.latestAttentionAt,
        };
      } catch (error) {
        if (isNotFound(error)) return { kind: "gone" };
        throw error;
      }
    },
  };
}

export function bbNames(sdk: PluginBbSdk): NamesPort {
  const projectName = cached(async (projectId) => (await sdk.projects.get({ projectId })).name);
  return {
    async thread(threadId) {
      try {
        const thread = await sdk.threads.get({ threadId });
        return { title: thread.title ?? thread.titleFallback, projectId: thread.projectId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    projectName,
  };
}

/**
 * A thread's timeline as bb's app shows it: the top-level rows, a page of
 * twenty turns at a time, content deferred since only ids and times are read.
 */
export function bbTimeline(sdk: PluginBbSdk): TimelinePort {
  return {
    async page(threadId, older, signal) {
      const result = await sdk.threads.timeline({
        threadId,
        signal,
        deferContent: "true",
        ...(older === null ? {} : { beforeAnchorId: older.anchorId, beforeAnchorSeq: String(older.anchorSeq) }),
      });
      const messages = result.rows.flatMap((row) =>
        row.kind !== "conversation"
          ? []
          : [{ id: row.id, createdAt: row.createdAt, role: row.role, initiator: row.role === "user" ? row.initiator : null }],
      );
      const turns = result.rows.flatMap((row) => (row.kind === "turn" ? [{ startedAt: row.startedAt, completedAt: row.completedAt }] : []));
      return { messages, turns, older: result.timelinePage.olderCursor };
    },
    async running(threadId) {
      const { status } = await sdk.threads.get({ threadId });
      return status !== "idle" && status !== "error";
    },
  };
}

export function bbThreadChoices(sdk: PluginBbSdk): ThreadChoicesPort {
  return {
    async ancestors(threadIds) {
      if (threadIds.length === 0) return [];
      return (await sdk.threads.experimental_listAncestors({ threadIds })).threads;
    },
    async ownChoices(threadIds) {
      const own = new Map<string, ThreadChoice>();
      if (threadIds.length === 0) return own;
      // `pluginId` is filled in by the plugin-bound SDK: these are Herald's own.
      for (const { threadId, metadata } of (await sdk.threads.experimental_listPluginMetadata({ threadIds })).threads) {
        const choice = ownChoiceOf(metadata);
        if (choice !== null) own.set(threadId, choice);
      }
      return own;
    },
    async setOwn(threadId, choice) {
      await sdk.threads.updatePluginMetadata(
        choice === null ? { threadId, remove: [CHOICE_METADATA_KEY] } : { threadId, set: { [CHOICE_METADATA_KEY]: choice } },
      );
    },
  };
}

/** How long bb's notification defaults are trusted; they change only in its settings. */
const DEFAULTS_TTL_MS = 30_000;

const PushOwnLevelsSchema = z.object({
  threads: z.record(z.string(), z.object({ own: OwnLevelSchema }).passthrough()),
});
const PushSentSchema = z.object({ ok: z.literal(true), channels: z.array(z.string()) }).passthrough();

/**
 * bb's push-notifications plugin, through `bb.sdk.plugins`. Its RPC contract is
 * not published as a package, so the shapes read here are kept in
 * `shared/push.ts`, as of bb 0.48.1.
 */
export function bbPush(sdk: PluginBbSdk, log: Log): PushPort {
  let defaults: { at: number; value: LevelDefaults } | null = null;
  return {
    async unavailable() {
      // A member an older bb lacks; read it loosely so a bb before 0.48.1 says so instead of throwing.
      const plugins = sdk.plugins as Partial<Pick<PluginBbSdk["plugins"], "experimental_discoverRpc">>;
      if (typeof plugins.experimental_discoverRpc !== "function") {
        return "This bb cannot send a notification for a plugin; that needs bb 0.48.1 or later.";
      }
      const methods = await plugins.experimental_discoverRpc({ pluginId: PUSH_PLUGIN_ID, method: PUSH_SEND_METHOD });
      return methods.some((method) => method.pluginId === PUSH_PLUGIN_ID && method.method === PUSH_SEND_METHOD)
        ? null
        : "bb's Push notifications plugin is off, or this bb cannot send a notification for a plugin (that needs bb 0.48.1).";
    },
    async ancestors(threadId) {
      const { threads } = await sdk.threads.experimental_listAncestors({ threadIds: [threadId] });
      return threads.find((thread) => thread.threadId === threadId)?.ancestorIds ?? null;
    },
    async descendants(threadId) {
      const { threads } = await sdk.threads.experimental_listDescendants({ threadIds: [threadId] });
      return threads.find((thread) => thread.threadId === threadId)?.descendantIds ?? [];
    },
    async ownLevels(threadIds) {
      const { threads } = await sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN_ID,
        method: PUSH_LEVELS_LIST_METHOD,
        input: { threadIds: [...threadIds] },
        outputSchema: PushOwnLevelsSchema,
      });
      const own = new Map<string, OwnLevel>();
      for (const [threadId, row] of Object.entries(threads)) if (row.own !== "inherit") own.set(threadId, row.own);
      return own;
    },
    async setOwnLevel(threadId, level) {
      await sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN_ID,
        method: PUSH_LEVEL_SET_METHOD,
        input: { threadId, level },
        outputSchema: z.unknown(),
      });
    },
    async defaults() {
      if (defaults !== null && Date.now() - defaults.at < DEFAULTS_TTL_MS) return defaults.value;
      let value = BB_LEVEL_DEFAULTS;
      try {
        const { values } = await sdk.plugins.getSettings({ pluginId: PUSH_PLUGIN_ID });
        const defaultLevel = NotificationLevelSchema.safeParse(values.defaultLevel);
        const childLevel = OwnLevelSchema.safeParse(values.childLevel);
        value = {
          defaultLevel: defaultLevel.success ? defaultLevel.data : BB_LEVEL_DEFAULTS.defaultLevel,
          childLevel: childLevel.success ? childLevel.data : BB_LEVEL_DEFAULTS.childLevel,
        };
      } catch (error) {
        log.warn(`Could not read bb's notification defaults; using bb's own: ${reasonOf(error)}`);
      }
      defaults = { at: Date.now(), value };
      return value;
    },
    async send({ title, body, threadId }) {
      const { channels } = await sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN_ID,
        method: PUSH_SEND_METHOD,
        input: { title, body, threadId },
        outputSchema: PushSentSchema,
      });
      // No channel on is not a failure: bb's own notification would have reached nothing either.
      if (channels.length === 0) log.info(`The notification for ${threadId} reached no channel: none is on in bb's Push notifications.`);
    },
  };
}
