/**
 * The ports (`ports.ts`) over `bb.sdk`. Kept thin on purpose: every decision lives in the modules that
 * use the ports, which are tested against the fakes; this file only translates shapes.
 *
 * Call it from handlers and services, not the plugin factory body — `bb.sdk` is for use once loaded.
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { PluginBbSdk } from "@get-bb/plugin-sdk";

import type { ProjectsPort, SendMode, SpawnEnvironment, ThreadInfo, ThreadsPort } from "./ports";

type SpawnRequest = Parameters<PluginBbSdk["threads"]["spawn"]>[0];
type ReasoningLevel = NonNullable<SpawnRequest["reasoningLevel"]>;

/** Every reasoning level bb accepts; a `Record` so the compiler flags a level bb adds or drops. */
const REASONING_LEVELS: Record<ReasoningLevel, true> = {
  none: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  ultra: true,
  ultracode: true,
};

function isReasoningLevel(value: string): value is ReasoningLevel {
  return Object.hasOwn(REASONING_LEVELS, value);
}

/** The fields of a bb thread row the plugin reads; `threads.get` and `threads.list` rows both have them. */
interface ThreadRow extends ThreadInfo {
  deletedAt: number | null;
}

function toInfo(row: ThreadRow): ThreadInfo {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    parentThreadId: row.parentThreadId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function isLive(row: ThreadRow): boolean {
  return row.archivedAt === null && row.deletedAt === null;
}

/**
 * The SDK rejects a failed request with its internal `BbHttpError`, which carries the HTTP `status`
 * (and a `code`). The class is not part of the public SDK, so it is recognised by shape.
 */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

function environmentOf(environment: SpawnEnvironment): SpawnRequest["environment"] {
  switch (environment.kind) {
    case "worktree":
      return { type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
    case "reuse":
      return { type: "reuse", environmentId: environment.environmentId };
    case "path":
      return { type: "host", workspace: { type: "unmanaged", path: environment.path } };
  }
}

function reasoningOf(level: string | undefined): ReasoningLevel | undefined {
  if (level === undefined || level === "") return undefined;
  if (!isReasoningLevel(level)) {
    throw new Error(`bb has no reasoning level "${level}". Use one of: ${Object.keys(REASONING_LEVELS).join(", ")}.`);
  }
  return level;
}

/** Empty strings mean "bb's default", which the SDK expresses by leaving the field out. */
function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function bbThreads(sdk: PluginBbSdk): ThreadsPort {
  return {
    async get(id) {
      try {
        const row = await sdk.threads.get({ threadId: id });
        return isLive(row) ? toInfo(row) : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async children(parentId) {
      const rows = await sdk.threads.list({ parentThreadId: parentId, archived: false });
      return rows.filter(isLive).map(toInfo);
    },
    async metadata(id) {
      return sdk.threads.getPluginMetadata({ threadId: id });
    },
    async pendingInteractions(id) {
      const interactions = await sdk.threads.interactions.list({ threadId: id });
      return interactions.filter((interaction) => interaction.status === "pending").length;
    },
    async lastText(id) {
      return (await sdk.threads.output({ threadId: id })).output;
    },
    async spawn(args) {
      const row = await sdk.threads.spawn({
        projectId: args.projectId,
        title: args.title,
        prompt: args.prompt,
        parentThreadId: args.parentThreadId,
        environment: environmentOf(args.environment),
        providerId: optional(args.providerId),
        model: optional(args.model),
        reasoningLevel: reasoningOf(args.reasoningLevel),
        pluginMetadata: args.metadata,
      });
      return toInfo(row);
    },
    async send(id, text, mode: SendMode) {
      const result = await sdk.threads.send({ threadId: id, mode, input: [{ type: "text", text, mentions: [] }] });
      return result.delivery;
    },
    async stop(id) {
      await sdk.threads.stop({ threadId: id });
    },
    async archive(id) {
      await sdk.threads.archive({ threadId: id });
    },
    async clearContext(id) {
      await sdk.threads.clearContext({ threadId: id });
    },
    async pin(id) {
      await sdk.threads.pin({ threadId: id });
    },
  };
}

/** The directory as the filesystem names it, through symlinks; a path that does not exist is compared as written. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The host id of the bb server's own machine, where the home lives. `system.config()` reports it as
 * `primaryHostId` — the host whose id bb keeps in its data directory.
 */
async function serverHostId(sdk: PluginBbSdk): Promise<string | null> {
  return (await sdk.system.config()).primaryHostId;
}

export function bbProjects(sdk: PluginBbSdk): ProjectsPort {
  return {
    async findByPath(path) {
      const [hostId, target, projects] = await Promise.all([serverHostId(sdk), canonical(path), sdk.projects.list()]);
      for (const project of projects) {
        for (const source of project.sources) {
          if (hostId !== null && source.hostId !== hostId) continue;
          if ((await canonical(source.path)) === target) return { id: project.id };
        }
      }
      return null;
    },
    async create(name, path) {
      const hostId = await serverHostId(sdk);
      if (hostId === null) throw new Error("bb reports no host for its own machine, so the home cannot be registered as a project.");
      const project = await sdk.projects.create({ name, source: { type: "local_path", hostId, path } });
      return { id: project.id };
    },
    async list() {
      return (await sdk.projects.list()).map((project) => ({ id: project.id, name: project.name }));
    },
  };
}
