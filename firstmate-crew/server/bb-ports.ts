/**
 * The ports (`ports.ts`) over `bb.sdk`. Kept thin on purpose: every decision lives in the modules that
 * use the ports, which are tested against the fakes; this file only translates shapes.
 *
 * Call it from handlers and services, not the plugin factory body — `bb.sdk` is for use once loaded.
 */
import type { PluginBbSdk } from "@get-bb/plugin-sdk";

import { canonicalPath } from "./files";
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

/** The request's answer, or null when bb answers 404. */
async function nullIfNotFound<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The host id of the bb server's own machine, where the home lives. `system.config()` reports it as
 * `primaryHostId` — the host whose id bb keeps in its data directory.
 */
async function serverHostId(sdk: PluginBbSdk): Promise<string | null> {
  return (await sdk.system.config()).primaryHostId;
}

function requireHost(hostId: string | null | undefined, what: string): string {
  if (hostId === null || hostId === undefined) throw new Error(`bb reports no machine for ${what}, so the thread cannot be started.`);
  return hostId;
}

/**
 * The machine a new worktree of the project goes on: the project's checkout on the bb server's machine
 * when it has one (as `bb thread spawn` does from the server's shell), else its default checkout's.
 */
async function worktreeHostId(sdk: PluginBbSdk, projectId: string): Promise<string> {
  const [serverHost, project] = await Promise.all([serverHostId(sdk), sdk.projects.get({ projectId })]);
  const onServer = project.sources.find((source) => source.hostId === serverHost);
  const chosen = onServer ?? project.sources.find((source) => source.isDefault) ?? project.sources[0];
  return requireHost(chosen?.hostId, `project ${projectId}'s checkout`);
}

/**
 * bb requires a host environment to name its machine (`hostId`) even though the type marks it
 * optional: without one, the spawn fails with "hostId is required unless workspace.type is personal".
 */
async function environmentOf(sdk: PluginBbSdk, projectId: string, environment: SpawnEnvironment): Promise<SpawnRequest["environment"]> {
  switch (environment.kind) {
    case "worktree":
      return {
        type: "host",
        hostId: await worktreeHostId(sdk, projectId),
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      };
    case "reuse":
      return { type: "reuse", environmentId: environment.environmentId };
    case "path":
      return {
        type: "host",
        hostId: requireHost(await serverHostId(sdk), "the bb server"),
        workspace: { type: "unmanaged", path: environment.path },
      };
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
    async workspacePath(environmentId) {
      const [serverHost, environment] = await Promise.all([serverHostId(sdk), sdk.environments.get({ environmentId })]);
      return environment.hostId === serverHost ? environment.path : null;
    },
    async origin(id) {
      const row = await nullIfNotFound(sdk.threads.get({ threadId: id }));
      if (row === null) return null;
      const [project, environment] = await Promise.all([
        nullIfNotFound(sdk.projects.get({ projectId: row.projectId })),
        row.environmentId === null ? null : nullIfNotFound(sdk.environments.get({ environmentId: row.environmentId })),
      ]);
      return { projectName: project?.name ?? null, branchName: environment?.branchName ?? null };
    },
    async spawn(args) {
      const row = await sdk.threads.spawn({
        projectId: args.projectId,
        title: args.title,
        prompt: args.prompt,
        parentThreadId: args.parentThreadId,
        environment: await environmentOf(sdk, args.projectId, args.environment),
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
    async sendShortened(id, message, mode: SendMode) {
      // The chip is a path mention over the path's own text, the way bb's composer writes one.
      const shown = `${message.shown} · ${message.file.path}`;
      const result = await sdk.threads.send({
        threadId: id,
        mode,
        input: [
          {
            type: "text",
            text: shown,
            mentions: [
              {
                start: shown.length - message.file.path.length,
                end: shown.length,
                resource: {
                  kind: "path",
                  source: "workspace",
                  entryKind: "file",
                  path: message.file.path,
                  label: message.file.label,
                },
              },
            ],
          },
          { type: "text", text: message.hidden, mentions: [], visibility: "agent-only" },
        ],
      });
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
    async compact(id) {
      await sdk.threads.compact({ threadId: id });
    },
    async pin(id) {
      await sdk.threads.pin({ threadId: id });
    },
  };
}

export function bbProjects(sdk: PluginBbSdk): ProjectsPort {
  return {
    async findByPath(path) {
      const [hostId, target, projects] = await Promise.all([serverHostId(sdk), canonicalPath(path), sdk.projects.list()]);
      for (const project of projects) {
        for (const source of project.sources) {
          if (hostId !== null && source.hostId !== hostId) continue;
          if ((await canonicalPath(source.path)) === target) return { id: project.id };
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
