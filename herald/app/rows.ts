/**
 * What the panel lists: bb decides *who* is waiting, Herald explains *why*.
 *
 * Two sources, joined by thread id. bb's own state — the sidebar's unread dot
 * and its "waiting for input" — decides who is listed, live, without a round
 * trip; Herald's entries add the reason and the sentence. A thread bb flags
 * that Herald has no entry for (an event from before the plugin was watching,
 * say) is still listed, with what bb knows.
 */
import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";

import type { AttentionEntry, AttentionReason } from "../shared/herald";

/** The fields of bb's sidebar thread this join reads. */
export interface ThreadState {
  id: string;
  projectId: string;
  displayTitle: string;
  status: string;
  isHidden: boolean;
  isArchived: boolean;
  isUnread: boolean;
  hasPendingInteraction: boolean;
  indicator: PluginSidebarThreadIndicator;
  latestAttentionAt: number;
}

/** A row's reason: one of Herald's, or what bb alone says. */
export type RowReason = AttentionReason | "input" | "attention";

export interface Row {
  threadId: string;
  projectId: string;
  title: string;
  reason: RowReason;
  /** Epoch ms the row sorts by: the event, or when bb last flagged the thread. */
  at: number;
  entry: AttentionEntry | null;
  /** bb's status for the thread, drawn with bb's own glyph; null while bb's list is loading. */
  indicator: PluginSidebarThreadIndicator | null;
}

/**
 * How long a fresh entry is listed even once its thread reads as seen: the
 * user may be looking at the thread as it finishes, and the sentence should
 * still reach the panel. The same grace the server's liveness uses.
 */
export const FRESH_ENTRY_MS = 15_000;

function isWorking(thread: ThreadState): boolean {
  return (thread.status === "active" || thread.status === "starting") && !thread.hasPendingInteraction;
}

function isFlagged(thread: ThreadState): boolean {
  return !thread.isHidden && !thread.isArchived && (thread.isUnread || thread.hasPendingInteraction);
}

/**
 * Whether an entry still describes its thread. An entry for an interaction
 * lasts while bb says the thread waits for input — answering it fires nothing
 * Herald hears, so this is what takes it off the panel at once. A finish on a
 * thread that is working again is hidden: some providers report a turn as
 * finished and carry on.
 */
function isCurrentEntry(entry: AttentionEntry, thread: ThreadState, now: number): boolean {
  if (thread.isArchived) return false;
  if (entry.requestId !== null) return thread.hasPendingInteraction;
  if (entry.reason === "finished" && isWorking(thread)) return false;
  if (isFlagged(thread)) return true;
  return now - Date.parse(entry.createdAt) < FRESH_ENTRY_MS;
}

/**
 * How long after a quiet finished turn was recorded bb may still date the
 * attention that turn raised. bb flags the thread as the turn ends and Herald
 * records it once its lookups return, so the two are close; a flag later
 * than this is a newer event Herald did not record, and is listed.
 */
export const QUIET_ATTENTION_SLACK_MS = 15_000;

/**
 * Whether bb flags the thread only for the finished turn the sentence tool
 * kept quiet: unread, nothing waiting for input, no error, and no attention
 * newer than that turn. Such a flag is not listed, nor counted on the badge.
 */
function flaggedOnlyForQuietTurn(thread: ThreadState, quietAt: number | undefined): boolean {
  if (quietAt === undefined || thread.hasPendingInteraction || thread.indicator === "unread-error") return false;
  return thread.latestAttentionAt <= quietAt + QUIET_ATTENTION_SLACK_MS;
}

function reasonFromBb(thread: ThreadState): RowReason {
  if (thread.hasPendingInteraction) return "input";
  if (thread.indicator === "unread-error") return "error";
  if (thread.indicator === "unread-success") return "finished";
  return "attention";
}

/**
 * The panel's rows, newest first. `threads` is null while bb's thread list is
 * still loading, and then Herald's entries are shown as they are.
 */
export function joinRows(entries: readonly AttentionEntry[], threads: readonly ThreadState[] | null, now: number): Row[] {
  const byId = new Map((threads ?? []).map((thread) => [thread.id, thread]));
  const rows = new Map<string, Row>();
  /** Threads whose last Herald event is a finished turn the tool kept quiet, with when it was recorded. */
  const quietAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.summary.status === "quiet") {
      quietAt.set(entry.threadId, Date.parse(entry.createdAt));
      continue;
    }
    const thread = byId.get(entry.threadId);
    if (threads !== null && (thread === undefined || !isCurrentEntry(entry, thread, now))) continue;
    rows.set(entry.threadId, {
      threadId: entry.threadId,
      projectId: entry.projectId,
      title: thread?.displayTitle ?? entry.threadTitle ?? entry.projectName ?? "A thread",
      reason: entry.reason,
      at: Date.parse(entry.createdAt),
      entry,
      indicator: thread?.indicator ?? null,
    });
  }
  for (const thread of threads ?? []) {
    if (rows.has(thread.id) || !isFlagged(thread) || isWorking(thread)) continue;
    if (flaggedOnlyForQuietTurn(thread, quietAt.get(thread.id))) continue;
    rows.set(thread.id, {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.displayTitle,
      reason: reasonFromBb(thread),
      at: thread.latestAttentionAt,
      entry: null,
      indicator: thread.indicator,
    });
  }
  return [...rows.values()].sort((a, b) => b.at - a.at);
}
