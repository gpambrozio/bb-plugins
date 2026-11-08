/**
 * `Ports` over the real bb: the SDK for threads, projects, providers and forms, and bb's bundled Git
 * (`bb--git`) and GitHub PR Status (`bb--github-pr-status`) plugins for HEAD, commits and pull
 * requests. Their contracts are not published, so this keeps a copy of the parts it reads; the
 * schemas are not strict, so a field a later bb adds is dropped, not refused.
 *
 * A read that fails answers "unknown" (null, false, empty) rather than throwing: an offer is never
 * worth failing a thread event for.
 */
import type { BbPluginApi, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { posix } from "node:path";

import { z } from "zod";

import { ORIENT_LIMITS } from "../shared/orientation";
import { CARD_RENDERER_ID, PLUGIN_ID, type SettledRow } from "../shared/types";
import {
  FileConflict,
  type CardRequest,
  type FileRead,
  type FileRoot,
  type ForkRequest,
  type MessageRead,
  type Ports,
  type ProjectInfo,
  type PullRequestInfo,
  type SpawnRequest,
  type ThreadInfo,
} from "./ports";
import type { FileChange } from "./signals";

export const GIT_PLUGIN_ID = "bb--git";
export const PR_STATUS_PLUGIN_ID = "bb--github-pr-status";
/** The key the session id is seeded under on a session thread's plugin metadata. */
export const SESSION_METADATA_KEY = "session";

const commitSchema = z.object({ sha: z.string(), subject: z.string() });
const workspaceStatusSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      checkout: z.object({ headSha: z.string().nullable().optional() }),
      branch: z.object({ currentBranch: z.string().nullable(), defaultBranch: z.string().nullable() }).partial().optional(),
      mergeBase: z
        .object({
          commits: z.array(commitSchema),
          files: z.array(z.object({ path: z.string(), status: z.string() })).optional(),
        })
        .nullable()
        .optional(),
    }),
  }),
  z.object({ outcome: z.literal("not_applicable") }),
  z.object({ outcome: z.literal("unavailable") }),
]);

const pullRequestsSchema = z.record(
  z.string(),
  z
    .object({
      outcome: z.string(),
      pullRequest: z.object({ url: z.string(), title: z.string(), state: z.string() }).passthrough().optional(),
    })
    .passthrough(),
);

const fileChangeItemSchema = z.object({
  type: z.literal("fileChange"),
  changes: z.array(z.object({ kind: z.enum(["add", "update", "delete"]), path: z.string() }).passthrough()).optional(),
});

const agentMessageItemSchema = z.object({ type: z.literal("agentMessage"), text: z.string() });

/**
 * Rows per page of the event log: the most bb takes. bb 0.48.1 refuses a larger `limit` with "HTTP 400:
 * Thread event limit cannot exceed 100" (`THREAD_EVENT_LIST_PAGE_SIZE`), so every read pages.
 */
export const EVENT_PAGE = 100;

/** The most pages a turn's file changes are looked for in (300 rows, newest first). */
const FILE_CHANGE_PAGES = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The most threads bb lists in one call. */
const THREAD_LIST_LIMIT = 200;

/**
 * Whether a failed `files.read` says the file is not there. bb's file calls are not documented to
 * fail in a typed way, so this accepts a `not_found` code (the SDK's RPC error code) or an ENOENT /
 * "not found" / "no such file" message. Hash mismatches on write are not errors: `files.write`
 * answers `{ outcome: "conflict" }`, which `diff-review/server/edits.ts` (`written`) checks the same way.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not_found" || code === "ENOENT") return true;
  return /not found|no such file|enoent|does not exist/i.test(message(error));
}

/** UTF-8 text from file bytes, or null when they are not valid UTF-8 or hold a NUL. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function settledDetail(row: SettledRow): string {
  const lines = [`**Question:** ${row.question}`];
  if (row.action === "answer") lines.push("", `**Answer:** ${row.answer ?? ""}`, "", `Confidence ${row.confidence ?? "?"}/5`);
  else if (row.action === "skip") lines.push("", "Skipped.");
  else if (row.action === "more-specific") lines.push("", "Asked for a more specific question.");
  else lines.push("", "Paused the session.");
  return lines.join("\n");
}

const SETTLED_TITLES: Record<SettledRow["action"], string> = {
  answer: "Answered an exercise",
  skip: "Skipped an exercise",
  "more-specific": "Asked for a more specific question",
  pause: "Paused the learning session",
};

export function bbPorts(bb: BbPluginApi, changed: () => void): Ports {
  const sdk = () => bb.sdk;

  async function git<T>(method: string, input: Record<string, unknown>, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return await sdk().plugins.callRpc({ pluginId: GIT_PLUGIN_ID, method, input: input as never, outputSchema: schema });
    } catch (error) {
      bb.log.debug(`Git plugin ${method} failed: ${message(error)}`);
      return null;
    }
  }

  return {
    now: () => Date.now(),

    async thread(threadId): Promise<ThreadInfo | null> {
      try {
        const thread = await sdk().threads.get({ threadId });
        return {
          id: thread.id,
          projectId: thread.projectId,
          providerId: thread.providerId,
          environmentId: thread.environmentId,
          title: thread.title ?? thread.titleFallback,
          status: thread.status,
          parentThreadId: thread.parentThreadId,
          originPluginId: thread.originPluginId,
          lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
          visibility: thread.visibility,
          archivedAt: thread.archivedAt,
        };
      } catch {
        return null;
      }
    },

    async project(projectId): Promise<ProjectInfo | null> {
      try {
        const project = await sdk().projects.get({ projectId });
        return { id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl ?? null };
      } catch {
        return null;
      }
    },

    async environmentPath(environmentId) {
      try {
        return (await sdk().environments.get({ environmentId })).path ?? null;
      } catch {
        return null;
      }
    },

    async environmentRoot(environmentId): Promise<FileRoot | null> {
      try {
        const environment = await sdk().environments.get({ environmentId });
        return environment.path === null || environment.path === undefined ? null : { hostId: environment.hostId, rootPath: environment.path };
      } catch {
        return null;
      }
    },

    async projectCheckout(projectId, hostId) {
      try {
        const project = await sdk().projects.get({ projectId });
        return project.sources.find((source) => source.hostId === hostId)?.path ?? null;
      } catch {
        return null;
      }
    },

    async readFile(root, relativePath): Promise<FileRead | null> {
      let file;
      try {
        file = await sdk().files.read({ hostId: root.hostId, rootPath: root.rootPath, path: posix.join(root.rootPath, relativePath) });
      } catch (error) {
        if (isNotFound(error)) return { kind: "missing" };
        bb.log.debug(`Reading ${relativePath} failed: ${message(error)}`);
        return null;
      }
      if (file.sizeBytes > ORIENT_LIMITS.fileBytes) return { kind: "too-large" };
      const text = file.contentEncoding === "base64" ? utf8Text(Buffer.from(file.content, "base64")) : utf8Text(Buffer.from(file.content, "utf8"));
      return text === null ? { kind: "binary" } : { kind: "text", text, sha256: file.sha256, sizeBytes: file.sizeBytes };
    },

    async writeFile(root, relativePath, content, expectedSha256) {
      const result = await sdk().files.write({
        hostId: root.hostId,
        rootPath: root.rootPath,
        path: posix.join(root.rootPath, relativePath),
        content,
        contentEncoding: "utf8",
        createParents: true,
        expectedSha256,
      });
      if (result.outcome === "conflict") throw new FileConflict(relativePath);
    },

    async currentTurn(threadId) {
      try {
        const rows = await sdk().threads.events.list({ threadId, types: ["turn/started"], order: "desc", limit: "1" });
        const scope = rows[0]?.scope as { turnId?: unknown } | null | undefined;
        return typeof scope?.turnId === "string" ? scope.turnId : null;
      } catch (error) {
        bb.log.warn(`Reading ${threadId}'s current turn failed: ${message(error)}`);
        return null;
      }
    },

    async lastTurn(threadId) {
      try {
        const rows = await sdk().threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "1" });
        const row = rows[0];
        if (row === undefined) return null;
        const scope = row.scope as { turnId?: unknown } | null | undefined;
        const data = row.data as { status?: unknown };
        if (typeof scope?.turnId !== "string") return null;
        return { turnId: scope.turnId, status: typeof data.status === "string" ? data.status : "unknown" };
      } catch {
        return null;
      }
    },

    async turnFileChanges(threadId, turnId) {
      // The turn just ended, so its rows are the newest: read back until past them.
      try {
        const changes: FileChange[] = [];
        let beforeSeq: string | undefined;
        let inTurn = false;
        for (let page = 0; page < FILE_CHANGE_PAGES; page += 1) {
          const rows = await sdk().threads.events.list({
            threadId,
            types: ["item/completed"],
            order: "desc",
            limit: String(EVENT_PAGE),
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          });
          for (const row of rows) {
            const scope = row.scope as { turnId?: unknown } | null | undefined;
            if (scope?.turnId !== turnId) {
              if (inTurn) return changes;
              continue;
            }
            inTurn = true;
            const item = fileChangeItemSchema.safeParse((row.data as { item?: unknown }).item);
            if (!item.success) continue;
            for (const change of item.data.changes ?? []) changes.push({ kind: change.kind, path: change.path });
          }
          const last = rows.at(-1);
          if (rows.length < EVENT_PAGE || last === undefined) break;
          beforeSeq = String(last.seq);
        }
        return changes;
      } catch (error) {
        bb.log.warn(`Reading the files ${threadId}'s turn changed failed: ${message(error)}`);
        return [];
      }
    },

    async agentMessages(threadId, { from, to, before, pages }): Promise<MessageRead | null> {
      // Newest first, a page at a time, until a row older than the window or the log's first row; bb
      // normalizes every provider's assistant text to an `agentMessage` item (Claude Code and Codex alike
      // in bb 0.48.1). Out of pages first, the read is incomplete and says where to go on.
      try {
        const found: string[] = [];
        let beforeSeq = before ?? undefined;
        let read = 0;
        while (read < pages) {
          const rows = await sdk().threads.events.list({
            threadId,
            types: ["item/completed"],
            order: "desc",
            limit: String(EVENT_PAGE),
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          });
          read += 1;
          for (const row of rows) {
            if (row.createdAt < from) return { texts: found.reverse(), complete: true, before: null, pages: read };
            if (to !== null && row.createdAt >= to) continue;
            const item = agentMessageItemSchema.safeParse((row.data as { item?: unknown }).item);
            if (item.success && item.data.text.trim() !== "") found.push(item.data.text);
          }
          const last = rows.at(-1);
          if (rows.length < EVENT_PAGE || last === undefined) return { texts: found.reverse(), complete: true, before: null, pages: read };
          beforeSeq = String(last.seq);
        }
        return { texts: found.reverse(), complete: false, before: beforeSeq ?? null, pages: read };
      } catch (error) {
        bb.log.warn(`Reading ${threadId}'s messages failed: ${message(error)}`);
        return null;
      }
    },

    async interactionPending(threadId) {
      try {
        const pending = (await sdk().threads.interactions.list({ threadId })) as readonly { status?: string }[];
        return pending.some((interaction) => interaction.status === "pending");
      } catch {
        return false;
      }
    },

    async headSha(environmentId) {
      const status = await git("workspaceStatus", { environmentId }, workspaceStatusSchema);
      return status?.outcome === "available" ? (status.workspace.checkout.headSha ?? null) : null;
    },

    async commitsSince(environmentId, sha) {
      // A SHA as the merge base gives exactly the commits since it, with the files they touched.
      const status = await git("workspaceStatus", { environmentId, mergeBaseBranch: sha }, workspaceStatusSchema);
      if (status?.outcome !== "available") return null;
      const base = status.workspace.mergeBase;
      if (base === null || base === undefined) return { commits: [], files: [] };
      // The Git plugin lists them oldest first (checked against bb 0.48.1).
      return { commits: base.commits, files: base.files ?? [] };
    },

    async branchCommits(environmentId) {
      // Without `mergeBaseBranch` the Git plugin asks for no merge base and answers `mergeBase: null`
      // (bb 0.48.1), and it refuses revision expressions such as `HEAD~1`. So: read the branch names, then
      // compare a feature branch with its default branch. On the default branch there is nothing ahead.
      const status = await git("workspaceStatus", { environmentId }, workspaceStatusSchema);
      if (status?.outcome !== "available") return [];
      const current = status.workspace.branch?.currentBranch ?? null;
      const base = status.workspace.branch?.defaultBranch ?? null;
      if (current === null || base === null || current === base) return [];
      const ahead = await git("workspaceStatus", { environmentId, mergeBaseBranch: base }, workspaceStatusSchema);
      // Oldest first from the Git plugin; the newest first here.
      return ahead?.outcome === "available" ? [...(ahead.workspace.mergeBase?.commits ?? [])].reverse() : [];
    },

    async pullRequest(environmentId): Promise<PullRequestInfo | null> {
      try {
        const rows = await sdk().plugins.callRpc({
          pluginId: PR_STATUS_PLUGIN_ID,
          method: "pullRequests",
          input: { keys: [environmentId] } as never,
          outputSchema: pullRequestsSchema,
        });
        const row = rows[environmentId];
        const pull = row?.outcome === "available" ? row.pullRequest : undefined;
        if (pull === undefined) return null;
        const state = ["open", "draft", "merged", "closed"].includes(pull.state) ? (pull.state as PullRequestInfo["state"]) : null;
        return state === null ? null : { url: pull.url, title: pull.title, state };
      } catch {
        return null;
      }
    },

    async canFork(providerId) {
      try {
        const providers = await sdk().providers.list();
        return providers.find((provider) => provider.id === providerId)?.capabilities.supportsFork === true;
      } catch {
        return false;
      }
    },

    async fork(request: ForkRequest) {
      const forked = await sdk().threads.fork({
        sourceThreadId: request.sourceThreadId,
        title: request.title,
        pluginMetadata: { [SESSION_METADATA_KEY]: request.sessionId },
        agentContextSeed: [{ type: "text", visibility: "agent-only", text: request.brief, mentions: [] }],
        input: [{ type: "text", text: request.visible, mentions: [] }],
        ...(request.environmentId === null ? {} : { environment: { type: "reuse", environmentId: request.environmentId } }),
      });
      return { threadId: forked.id };
    },

    async send(threadId, visible, agentOnly) {
      await sdk().threads.send({
        threadId,
        mode: "auto",
        input: [
          { type: "text", text: visible, mentions: [] },
          { type: "text", text: agentOnly, visibility: "agent-only", mentions: [] },
        ],
      });
    },

    async spawn(request: SpawnRequest) {
      const spawned = await sdk().threads.spawn({
        projectId: request.projectId,
        title: request.title,
        visibility: request.hidden ? "hidden" : "visible",
        environment: { type: "reuse", environmentId: request.environmentId },
        providerId: request.providerId,
        input: [
          { type: "text", text: request.visible, mentions: [] },
          { type: "text", text: request.agentOnly, visibility: "agent-only", mentions: [] },
        ],
        pluginMetadata: request.metadata,
      });
      return { threadId: spawned.id };
    },

    async stopThread(threadId) {
      await sdk().threads.stop({ threadId });
    },

    async archiveThread(threadId) {
      await sdk().threads.archive({ threadId });
    },

    async pluginThreadsWith(metadataKey) {
      // `originPluginId` filters on the server; hidden threads (the helpers) are listed only with
      // `includeHidden`, and `archived: false` keeps the builders already put away from filling the page.
      // Callers only put leftovers away, so one page of the newest 200 is enough.
      try {
        const rows = await sdk().threads.list({ originPluginId: PLUGIN_ID, includeHidden: true, archived: false, limit: THREAD_LIST_LIMIT });
        if (rows.length === 0) return [];
        const { threads } = await sdk().threads.experimental_listPluginMetadata({ threadIds: rows.map((row) => row.id).slice(0, THREAD_LIST_LIMIT) });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const found: { threadId: string; value: string; archived: boolean; status: string }[] = [];
        for (const entry of threads) {
          const value = (entry.metadata as Record<string, unknown>)[metadataKey];
          const row = byId.get(entry.threadId);
          if (typeof value !== "string" || row === undefined) continue;
          found.push({ threadId: entry.threadId, value, archived: row.archivedAt !== null && row.archivedAt !== undefined, status: row.status });
        }
        return found;
      } catch (error) {
        bb.log.warn(`Listing the plugin's threads failed: ${message(error)}`);
        return null;
      }
    },

    async metadataValue(threadId, key) {
      try {
        const metadata = await sdk().threads.getPluginMetadata({ threadId });
        const value = (metadata as Record<string, unknown> | null)?.[key];
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },

    sessionIdOf(threadId) {
      return this.metadataValue(threadId, SESSION_METADATA_KEY);
    },

    async forkOf(sessionId, sourceThreadId) {
      try {
        const forks = await sdk().threads.list({ sourceThreadId, originKind: "fork", archived: false, limit: 50 } as never);
        const ids = forks.map((thread) => thread.id).slice(0, 200);
        if (ids.length === 0) return null;
        const { threads } = await sdk().threads.experimental_listPluginMetadata({ threadIds: ids });
        return threads.find((row) => (row.metadata as Record<string, unknown>)[SESSION_METADATA_KEY] === sessionId)?.threadId ?? null;
      } catch {
        return null;
      }
    },

    async unarchive(threadId) {
      await sdk().threads.unarchive({ threadId });
    },

    card(request: CardRequest): Promise<PluginInteractionResult> {
      return bb.ui.requestInput(
        {
          threadId: request.threadId,
          rendererId: CARD_RENDERER_ID,
          title: `Question ${request.payload.ordinal}`,
          payload: request.payload,
          timeoutMs: 30 * 60_000,
          presentation: {
            label: { pending: "Waiting for your answer", completed: "Answered an exercise" },
            icon: { glyph: "Brain" },
          },
          describeSubmission: (value) => {
            const row = request.describe(value);
            return { title: SETTLED_TITLES[row.action], detail: settledDetail(row), payload: row };
          },
        },
        { signal: request.signal },
      );
    },

    changed,

    warn: (text) => bb.log.warn(text),
  };
}
