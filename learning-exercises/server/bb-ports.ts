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
import { z } from "zod";

import { CARD_RENDERER_ID, type SettledRow } from "../shared/types";
import type { CardRequest, ForkRequest, Ports, ProjectInfo, PullRequestInfo, ThreadInfo } from "./ports";
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      try {
        const rows = await sdk().threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "300" });
        const changes: FileChange[] = [];
        for (const row of rows) {
          const scope = row.scope as { turnId?: unknown } | null | undefined;
          if (scope?.turnId !== turnId) continue;
          const item = fileChangeItemSchema.safeParse((row.data as { item?: unknown }).item);
          if (!item.success) continue;
          for (const change of item.data.changes ?? []) changes.push({ kind: change.kind, path: change.path });
        }
        return changes;
      } catch {
        return [];
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
      const status = await git("workspaceStatus", { environmentId }, workspaceStatusSchema);
      // Oldest first from the Git plugin; the newest first here.
      return status?.outcome === "available" ? [...(status.workspace.mergeBase?.commits ?? [])].reverse() : [];
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

    async sessionIdOf(threadId) {
      try {
        const metadata = await sdk().threads.getPluginMetadata({ threadId });
        const value = (metadata as Record<string, unknown> | null)?.[SESSION_METADATA_KEY];
        return typeof value === "string" ? value : null;
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
