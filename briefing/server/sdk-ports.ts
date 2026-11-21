/**
 * `BriefingPorts` over `bb.sdk`. Every call only reads, and each one gives up after `CALL_TIMEOUT_MS` or
 * when the CLI's caller goes, so one offline machine or slow thread cannot hold the voice up for long.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { FIRSTMATE_PLUGIN_ID, FLEET_METHOD, FleetSchema } from "./firstmate";
import type { RequestEvent } from "./messages";
import type { BriefingPorts, FileRead, FleetRead, ProjectRow, ThreadRow } from "./ports";

type Sdk = BbPluginApi["sdk"];

export const CALL_TIMEOUT_MS = 8_000;
/** bb's own cap on `threadIds` and `listDescendants` per request. */
const IDS_PER_CALL = 200;
const LIST_PAGE = 200;
/** No briefing reads more root threads than this. */
const MAX_ROOTS = 1_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a failed `files.read` says the file is not there (bb does not type its file errors). */
export function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404 || code === "not_found" || code === "ENOENT") return true;
  return /not found|no such file|enoent|does not exist/i.test(message(error));
}

/**
 * Why bb refused to read this one file, in plain words, or null when the failure is the machine's (offline,
 * timed out, cancelled) rather than the file's. bb answers a file outside `rootPath` with `invalid_path`
 * ("escapes read root"), a large one with `file_too_large`, and passes the file system's own codes through.
 */
export function fileRefusal(error: unknown): string | null {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const status = (error as { status?: unknown } | null)?.status;
  const text = message(error);
  if (code === "invalid_path" || /escapes read root/i.test(text)) return "it points outside the project's folder";
  if (code === "file_too_large" || status === 413) return "it is too large";
  if (code === "EACCES" || code === "EPERM" || /\b(?:EACCES|EPERM)\b|permission denied/i.test(text)) return "permission denied";
  if (code === "EISDIR" || code === "ENOTDIR" || /\b(?:EISDIR|ENOTDIR)\b/.test(text)) return "it is not a file";
  if (status === 400 || status === 403) return text;
  return null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

interface ListRow {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  parentThreadId: string | null;
  archivedAt: number | null;
  status: string;
  runtime: { displayStatus: string };
  hasPendingInteraction: boolean;
  updatedAt: number;
  environmentHostId: string | null;
  environmentPath: string | null;
}

function toRow(row: ListRow): ThreadRow {
  return {
    id: row.id,
    title: row.title,
    titleFallback: row.titleFallback,
    projectId: row.projectId,
    parentThreadId: row.parentThreadId,
    archivedAt: row.archivedAt,
    status: row.runtime.displayStatus ?? row.status,
    hasPendingInteraction: row.hasPendingInteraction,
    updatedAt: row.updatedAt,
    hostId: row.environmentHostId,
    path: row.environmentPath,
  };
}

/** Plugin statuses whose RPCs answer. */
const CALLABLE_STATUSES = new Set(["running", "degraded"]);
/** Pages of completed items read back for a thread's last message of its own. */
const AGENT_MESSAGE_PAGES = 3;
const EVENT_PAGE = 100;

/** A completed item's text when it is a message of the thread's own agent, not a subagent's. */
export function ownAgentMessage(data: unknown): string | null {
  const item = (data as { item?: { type?: unknown; text?: unknown; parentToolCallId?: unknown } } | null)?.item;
  if (item?.type !== "agentMessage" || typeof item.text !== "string" || typeof item.parentToolCallId === "string") return null;
  return item.text.trim() === "" ? null : item.text;
}

export function sdkPorts(sdk: Sdk, caller: AbortSignal | undefined): BriefingPorts {
  const signal = (): AbortSignal => {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
  };

  async function lastOwnAgentMessage(threadId: string): Promise<string | null> {
    let beforeSeq: string | undefined;
    for (let page = 0; page < AGENT_MESSAGE_PAGES; page++) {
      const rows = await sdk.threads.events.list({
        threadId,
        types: ["item/completed"],
        order: "desc",
        limit: String(EVENT_PAGE),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        signal: signal(),
      });
      for (const row of rows) {
        const text = ownAgentMessage(row.data);
        if (text !== null) return text;
      }
      const last = rows.at(-1);
      if (rows.length < EVENT_PAGE || last === undefined) return null;
      beforeSeq = String(last.seq);
    }
    return null;
  }

  return {
    async rootThreads() {
      // Offset pages: a thread that moves between two reads can show up twice, so ids are kept once.
      const rows = new Map<string, ThreadRow>();
      for (let offset = 0; offset < MAX_ROOTS; offset += LIST_PAGE) {
        const page = await sdk.threads.list({ hasParent: false, archived: false, limit: LIST_PAGE, offset, signal: signal() });
        for (const row of page) if (!rows.has(row.id)) rows.set(row.id, toRow(row));
        if (page.length < LIST_PAGE) return { threads: [...rows.values()], complete: true };
      }
      return { threads: [...rows.values()], complete: false };
    },
    async descendants(rootIds) {
      const out = new Map<string, string[]>();
      for (const ids of chunks(rootIds, IDS_PER_CALL)) {
        const result = await sdk.threads.experimental_listDescendants({ threadIds: ids, signal: signal() });
        for (const entry of result.threads) out.set(entry.threadId, entry.descendantIds);
      }
      return out;
    },
    async threads(ids) {
      const rows: ThreadRow[] = [];
      for (const chunk of chunks(ids, IDS_PER_CALL)) {
        const page = await sdk.threads.list({ threadIds: chunk, limit: IDS_PER_CALL, signal: signal() });
        rows.push(...page.map(toRow));
      }
      return rows;
    },
    async thread(id) {
      const [row] = await sdk.threads.list({ threadIds: [id], limit: 1, signal: signal() });
      return row === undefined ? null : toRow(row);
    },
    async projects(): Promise<ProjectRow[]> {
      const projects = await sdk.projects.list({ includePersonal: true, signal: signal() });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        sources: [...project.sources]
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
          .map((source) => ({ hostId: source.hostId, path: source.path })),
      }));
    },
    async requests(threadId, order, limit, beforeSeq): Promise<RequestEvent[]> {
      const events = await sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order,
        limit: String(limit),
        ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }),
        signal: signal(),
      });
      return events.map((event) => ({ seq: event.seq, data: event.data }));
    },
    async lastAgentPreview(threadId) {
      const outline = await sdk.threads.conversationOutline({ threadId, role: "assistant", signal: signal() });
      return outline.items.at(-1)?.preview ?? null;
    },
    async latestReply(threadId) {
      const result = await sdk.threads.output({ threadId, signal: signal() });
      if (result.output !== null && result.output.trim() !== "") return result.output;
      // Since bb 0.49 this is the latest turn's reply only, and a turn that wrote none (a compaction, a
      // turn stopped first) has none: the reply before it is the thread's last message of its own.
      return lastOwnAgentMessage(threadId);
    },
    async readFile(hostId, root, name): Promise<FileRead> {
      const rootPath = root.replace(/\/+$/, "") || "/";
      try {
        // `rootPath` makes bb resolve the file's real path and refuse one outside the folder; without it,
        // a symlinked AGENTS.md would be followed anywhere on the machine.
        const file = await sdk.files.read({ hostId, path: `${rootPath === "/" ? "" : rootPath}/${name}`, rootPath, signal: signal() });
        const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
        return { kind: "text", text };
      } catch (error) {
        if (isMissingFile(error)) return { kind: "missing" };
        const refused = fileRefusal(error);
        if (refused !== null) return { kind: "refused", reason: refused };
        throw error;
      }
    },
    async fleet(): Promise<FleetRead> {
      const { plugins } = await sdk.plugins.list({ signal: signal() });
      const plugin = plugins.find((candidate) => candidate.id === FIRSTMATE_PLUGIN_ID);
      // Not installed or turned off: there is no first mate to brief on, and nothing to report.
      if (plugin === undefined || !plugin.enabled) return { ok: false, reason: "" };
      // "degraded" is a background service of its in trouble; its RPCs still answer.
      if (!CALLABLE_STATUSES.has(plugin.status)) return { ok: false, reason: `FirstMate Crew is ${plugin.status}.` };
      const fleet = await sdk.plugins.callRpc({
        pluginId: FIRSTMATE_PLUGIN_ID,
        method: FLEET_METHOD,
        input: {},
        outputSchema: FleetSchema,
        signal: signal(),
      });
      return { ok: true, fleet };
    },
  };
}
