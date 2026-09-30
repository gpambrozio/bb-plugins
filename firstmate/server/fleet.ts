/**
 * The board, assembled on the server: the first mate, its child threads, the backlog the first mate
 * keeps, and each crewmate's last status line — joined into cards and filed into columns.
 *
 * Nothing here is cached across calls except the status lines, and those are keyed by the thread's
 * `updatedAt`: a crewmate that has not moved is not asked for its last message again, which is what
 * keeps a poll every few seconds cheap with a large crew.
 */
import {
  CREW_METADATA,
  type BacklogItem,
  type ColumnId,
  type CrewReport,
  type CrewSummary,
  type Fleet,
  type FleetCard,
  type WatchSummary,
} from "../shared/types";
import { readCharterState } from "./charter-file";
import { parseCrewReport, reportUrl } from "./crew-report";
import { isHomeReady, readBacklog, readSuggestions } from "./home";
import { resolveMate, type MateDeps } from "./mate";
import type { ThreadInfo, ThreadsPort } from "./ports";
import { homePath } from "./settings";

interface CachedReport {
  updatedAt: number;
  report: CrewReport | null;
}

/** Each crewmate's last status line, read again only when the thread has moved. */
export class ReportCache {
  private readonly reports = new Map<string, CachedReport>();

  constructor(private readonly threads: ThreadsPort) {}

  async report(crew: CrewSummary): Promise<CrewReport | null> {
    const cached = this.reports.get(crew.threadId);
    // A turn in flight has not closed yet, so there is no new status line to read; the previous one
    // stays on the card until it does.
    if (crew.status !== "idle" && crew.status !== "error") return cached?.report ?? null;
    if (cached !== undefined && cached.updatedAt === crew.updatedAt) return cached.report;
    const report = parseCrewReport(await this.threads.lastText(crew.threadId));
    this.reports.set(crew.threadId, { updatedAt: crew.updatedAt, report });
    return report;
  }

  /** Records a turn's closing text the caller already has (`thread.idle` carries it), so the next read needs no fetch. */
  remember(threadId: string, updatedAt: number, text: string | null): void {
    this.reports.set(threadId, { updatedAt, report: parseCrewReport(text) });
  }

  /** Drops threads no longer in the crew, so the map cannot grow for the life of the server. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.reports.keys()) {
      if (!ids.has(id)) this.reports.delete(id);
    }
  }
}

/**
 * Where a crewmate belongs. What bb knows wins while the thread is busy or stuck — an interaction
 * waiting, an error, a turn in flight — and the status line decides once its turn has ended. A live
 * crewmate is never Done, even after `done:` or `resolved:`: the task has landed only once the backlog
 * says so, and until then the first mate still has work to do with it.
 */
export function crewColumn(crew: CrewSummary, report: CrewReport | null): ColumnId {
  if (crew.pendingInteractions > 0) return "blocked";
  switch (crew.status) {
    case "error":
      return "failed";
    case "active":
    case "starting":
    case "pending":
    case "stopping":
      return "working";
    case "idle":
      break;
  }
  switch (report?.state) {
    case "failed":
      return "failed";
    case "blocked":
    case "needs-decision":
      return "blocked";
    case "paused":
      return "parked";
    default:
      // Finished and waiting on the first mate, stopped without saying why, or said "working" and
      // then stopped.
      return "idle";
  }
}

/** Where a backlog item with no crewmate on it belongs. */
export function backlogColumn(item: BacklogItem): ColumnId {
  if (item.section === "done") return "done";
  if (item.section === "in-flight") return "idle";
  if (item.kind === "captain" || item.hold !== null) return "blocked";
  return "queued";
}

export interface CrewMember {
  summary: CrewSummary;
  report: CrewReport | null;
}

/**
 * Crewmates and backlog items joined into cards. A crewmate is matched to its item by its task
 * metadata, or by the thread id the item recorded; whatever is left over on either side is a card of
 * its own. An item in Done is never claimed: its id may be an older task's, and the landed work is
 * not the crewmate's to carry.
 */
export function buildCards(backlog: readonly BacklogItem[], crew: readonly CrewMember[]): FleetCard[] {
  const cards: FleetCard[] = [];
  const claimed = new Set<number>();

  const byUpdate = [...crew].sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
  for (const { summary, report } of byUpdate) {
    const index = backlog.findIndex(
      (item, position) =>
        !claimed.has(position) &&
        item.section !== "done" &&
        ((summary.task !== null && item.id === summary.task) || item.threadId === summary.threadId),
    );
    const item = index === -1 ? null : (backlog[index] ?? null);
    if (index !== -1) claimed.add(index);
    const taskId = summary.task ?? item?.id ?? null;
    cards.push({
      key: `crew:${summary.threadId}`,
      column: crewColumn(summary, report),
      taskId,
      title: item?.title ?? summary.title ?? taskId ?? "Untitled crewmate",
      project: summary.project ?? item?.project ?? null,
      kind: summary.kind ?? item?.kind ?? null,
      backlog: item,
      crew: summary,
      report,
      url: (report === null ? null : reportUrl(report.text)) ?? item?.url ?? null,
    });
  }

  backlog.forEach((item, index) => {
    if (claimed.has(index)) return;
    cards.push({
      key: `backlog:${item.section}:${item.id}:${index}`,
      column: backlogColumn(item),
      taskId: item.id,
      title: item.title,
      project: item.project,
      kind: item.kind,
      backlog: item,
      crew: null,
      report: null,
      url: item.url,
    });
  });
  return cards;
}

/** A metadata value the first mate wrote, as text; anything else — absent, empty, not a string — is null. */
export function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** What the board needs of one of the first mate's child threads. */
export async function summarizeCrew(threads: ThreadsPort, thread: ThreadInfo): Promise<CrewSummary> {
  const [metadata, pendingInteractions] = await Promise.all([threads.metadata(thread.id), threads.pendingInteractions(thread.id)]);
  return {
    threadId: thread.id,
    title: thread.title,
    status: thread.status,
    pendingInteractions,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    updatedAt: thread.updatedAt,
    task: metadataText(metadata, CREW_METADATA.task),
    kind: metadataText(metadata, CREW_METADATA.kind),
    project: metadataText(metadata, CREW_METADATA.project),
  };
}

export type FleetDeps = MateDeps & {
  reports: ReportCache;
  watches: () => Promise<WatchSummary[]>;
};

/** The whole board. A first mate that is gone leaves the backlog on the board with no crew joined to it. */
export async function loadFleet(deps: FleetDeps): Promise<Fleet> {
  const home = homePath((await deps.settings()).homeDirectory);
  const [storedMateId, mate, homeReady, backlog, suggestions, charter, watches] = await Promise.all([
    deps.store.mateThreadId(),
    resolveMate(deps),
    isHomeReady(home),
    readBacklog(home),
    readSuggestions(home),
    readCharterState(home),
    deps.watches(),
  ]);

  const children = mate === null ? [] : await deps.threads.children(mate.id);
  deps.reports.retain(new Set(children.map((child) => child.id)));
  const crew = await Promise.all(
    children.map(async (child) => {
      const summary = await summarizeCrew(deps.threads, child);
      const report = await deps.reports.report(summary).catch((error: unknown) => {
        console.error(`[firstmate] could not read the status line of ${child.id}:`, error);
        return null;
      });
      return { summary, report };
    }),
  );

  return {
    home,
    homeReady,
    mate: mate === null ? null : { threadId: mate.id, status: mate.status, title: mate.title },
    mateMissing: storedMateId !== null && mate === null,
    cards: buildCards(backlog, crew),
    suggestions,
    charter,
    watches,
  };
}
