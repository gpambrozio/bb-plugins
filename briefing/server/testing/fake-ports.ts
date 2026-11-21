/**
 * An in-memory bb for the tests: threads with their messages and replies, projects with files on
 * machines, and firstmate-crew's board. It pages events the way bb does (at most 100 per call, `desc`
 * from the end) and refuses more, so a test cannot pass on a read bb would reject.
 */
import type { FleetData } from "../firstmate";
import type { RequestEvent } from "../messages";
import type { BriefingPorts, FleetRead, ProjectRow, ThreadRow } from "../ports";

export interface FakeThread extends Partial<ThreadRow> {
  id: string;
  /** Requests in order; plain strings are the user's typed messages. */
  requests?: (string | Record<string, unknown>)[];
  /** The conversation outline's last assistant preview. */
  preview?: string | null;
  /** The latest turn's reply. */
  reply?: string | null;
}

export interface FakeBb {
  threads: FakeThread[];
  projects?: ProjectRow[];
  /** `<hostId>:<absolute path>` → content. */
  files?: Record<string, string>;
  /** `<hostId>:<absolute path>` → the absolute path that symlink points to, on the same machine. */
  links?: Record<string, string>;
  /** `<hostId>:<folder>` → the real folder that symlinked folder points to. */
  folderLinks?: Record<string, string>;
  /** `<hostId>:<folder>` → why that folder cannot be opened (gone, not a directory). */
  folderErrors?: Record<string, string>;
  /** `<hostId>:<absolute path>` → an error the machine answers for that one file (EACCES, too large). */
  fileErrors?: Record<string, string>;
  /** Machines whose reads fail. */
  offline?: string[];
  fleet?: FleetRead | (() => Promise<FleetRead>);
  /** Threads whose event reads fail. */
  failing?: string[];
  /** False to answer as if bb's list of root threads was cut at its cap. */
  rootsComplete?: boolean;
}

export function userRequest(text: string): Record<string, unknown> {
  return { initiator: "user", systemMessageKind: "unlabeled", input: [{ type: "text", text, mentions: [] }] };
}

function row(thread: FakeThread): ThreadRow {
  return {
    title: thread.title ?? thread.id.replace(/^thr_/, ""),
    titleFallback: null,
    projectId: "proj_a",
    parentThreadId: null,
    archivedAt: null,
    status: "idle",
    hasPendingInteraction: false,
    updatedAt: 0,
    hostId: null,
    path: null,
    ...thread,
  };
}

export function fakePorts(bb: FakeBb): BriefingPorts & { calls: string[] } {
  const calls: string[] = [];
  const rows = () => bb.threads.map(row);
  const find = (id: string) => bb.threads.find((thread) => thread.id === id);
  const events = (thread: FakeThread): RequestEvent[] =>
    (thread.requests ?? []).map((request, index) => ({ seq: (index + 1) * 10, data: typeof request === "string" ? userRequest(request) : request }));

  return {
    calls,
    async rootThreads() {
      calls.push("rootThreads");
      return { threads: rows().filter((thread) => thread.parentThreadId === null && thread.archivedAt === null), complete: bb.rootsComplete ?? true };
    },
    async descendants(rootIds) {
      calls.push("descendants");
      const all = rows();
      const below = (id: string): string[] =>
        all.filter((thread) => thread.parentThreadId === id).flatMap((child) => (child.archivedAt === null ? [child.id, ...below(child.id)] : below(child.id)));
      return new Map(rootIds.map((id) => [id, below(id)]));
    },
    async threads(ids) {
      return rows().filter((thread) => ids.includes(thread.id));
    },
    async thread(id) {
      return rows().find((thread) => thread.id === id) ?? null;
    },
    async projects() {
      return bb.projects ?? [];
    },
    async requests(threadId, order, limit, beforeSeq) {
      calls.push(`requests:${threadId}:${order}`);
      if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
      if (bb.failing?.includes(threadId)) throw new Error("events unavailable");
      const thread = find(threadId);
      const all = thread === undefined ? [] : events(thread);
      if (order === "asc") return all.slice(0, limit);
      const before = beforeSeq ?? Number.POSITIVE_INFINITY;
      return all
        .filter((event) => event.seq < before)
        .reverse()
        .slice(0, limit);
    },
    async lastAgentPreview(threadId) {
      return find(threadId)?.preview ?? null;
    },
    async latestReply(threadId) {
      calls.push(`reply:${threadId}`);
      return find(threadId)?.reply ?? null;
    },
    async realFolder(hostId, path) {
      calls.push(`folder:${hostId}:${path}`);
      if (bb.offline?.includes(hostId)) throw new Error(`host ${hostId} is offline`);
      const key = `${hostId}:${path.replace(/\/+$/, "")}`;
      const error = bb.folderErrors?.[key];
      if (error !== undefined) throw new Error(error);
      return bb.folderLinks?.[key] ?? path.replace(/\/+$/, "");
    },
    async readFile(hostId, root, name) {
      const folder = root.replace(/\/+$/, "");
      const path = `${folder}/${name}`;
      calls.push(`read:${hostId}:${path}`);
      if (bb.offline?.includes(hostId)) throw new Error(`host ${hostId} is offline`);
      // As bb does: a root that is itself a symlink is refused before any file is looked at.
      if (bb.folderLinks?.[`${hostId}:${folder}`] !== undefined) return { kind: "refused", reason: `Root path "${folder}" must not be a symlink` };
      const fileError = bb.fileErrors?.[`${hostId}:${path}`];
      if (fileError !== undefined) return { kind: "refused", reason: fileError };
      // As bb does with a `rootPath`: the real path must stay inside the folder.
      const real = bb.links?.[`${hostId}:${path}`] ?? path;
      if (!real.startsWith(`${folder}/`)) return { kind: "refused", reason: "it points outside the project's folder" };
      const text = bb.files?.[`${hostId}:${real}`];
      return text === undefined ? { kind: "missing" } : { kind: "text", text };
    },
    async fleet() {
      if (bb.fleet === undefined) return { ok: false, reason: "" };
      return typeof bb.fleet === "function" ? bb.fleet() : bb.fleet;
    },
  };
}

type Card = FleetData["cards"][number];

/** A board card with only what a test names; the rest as a plain queued backlog item. */
export function card(title: string, patch: { backlog?: Partial<NonNullable<Card["backlog"]>> | null } & Partial<Omit<Card, "backlog">> = {}): Card {
  const { backlog, ...rest } = patch;
  return {
    column: "queued",
    title,
    kind: null,
    crew: null,
    report: null,
    ...rest,
    backlog: backlog === null ? null : { section: "queued", hold: null, blockedBy: null, kind: null, ...backlog },
  };
}
