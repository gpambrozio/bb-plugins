/**
 * The ports (`ports.ts`) over `bb.sdk`. Kept thin on purpose: every decision
 * lives in the modules that use the ports, which are tested against fakes;
 * this file only translates shapes.
 *
 * Call these from handlers and services, never the plugin factory body —
 * `bb.sdk` is for use once the plugin is loaded.
 */
import type { PluginBbSdk } from "@get-bb/plugin-sdk";

import { isRunningStatus } from "./liveness";
import type { EventsPort, HelperPort, LivenessPort, Log } from "./ports";
import { lastPrompt } from "./timeline";

type SpawnRequest = Parameters<PluginBbSdk["threads"]["spawn"]>[0];
type ReasoningLevel = NonNullable<SpawnRequest["reasoningLevel"]>;

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
    async isRunning(threadId) {
      return isRunningStatus((await sdk.threads.get({ threadId })).status);
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
    interactionPending: (threadId, interactionId) => interactionPending(sdk, threadId, interactionId),
  };
}

/**
 * Helpers run in bb's personal project and workspace: a summary reads nothing
 * from a repository, so it needs no checkout, and the personal workspace
 * needs no machine but the server's own.
 */
export function bbHelpers(sdk: PluginBbSdk): HelperPort {
  let personalProjectId: string | null = null;

  async function personalProject(): Promise<string> {
    if (personalProjectId !== null) return personalProjectId;
    // Left out of the list unless asked for; every bb has one (`proj_personal`).
    const personal = (await sdk.projects.list({ includePersonal: true })).find((project) => project.kind === "personal");
    if (personal === undefined) throw new Error("bb reports no personal project to run the summary helper in.");
    personalProjectId = personal.id;
    return personal.id;
  }

  return {
    async spawn(args) {
      const [projectId, config] = await Promise.all([personalProject(), sdk.system.config()]);
      const thread = await sdk.threads.spawn({
        projectId,
        environment: {
          type: "host",
          ...(config.primaryHostId === null ? {} : { hostId: config.primaryHostId }),
          workspace: { type: "personal" },
        },
        providerId: args.providerId,
        model: args.model,
        reasoningLevel: args.reasoningLevel as ReasoningLevel,
        // Every tool but a file edit asks first, and a helper that asks is
        // stopped: the prompt forbids tools, and nothing should run unasked.
        permissionMode: "accept-edits",
        visibility: "hidden",
        title: args.title,
        prompt: args.prompt,
        pluginMetadata: args.metadata,
      });
      return thread.id;
    },
    async stop(threadId) {
      await sdk.threads.stop({ threadId });
    },
    async archive(threadId) {
      await sdk.threads.archive({ threadId });
    },
    async delete(threadId) {
      await sdk.threads.delete({ threadId, childThreadsConfirmed: true });
    },
  };
}
