/** Words and small pure helpers the board shares. */
import type { ColumnId, CrewState, ThreadStatus, WatchResult, WatchSummary } from "../shared/types";

export const COLUMN_TITLES: Readonly<Record<ColumnId, string>> = {
  queued: "Queued",
  working: "Working",
  blocked: "Blocked",
  parked: "Parked",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

export const STATE_WORDS: Readonly<Record<CrewState, string>> = {
  working: "Working",
  "needs-decision": "Needs a decision",
  blocked: "Blocked",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  resolved: "Resolved",
};

export const STATUS_WORDS: Readonly<Record<ThreadStatus, string>> = {
  pending: "starting",
  idle: "idle",
  starting: "starting",
  active: "working",
  stopping: "stopping",
  error: "errored",
};

/** Whether the thread is in the middle of a turn, so it can be interrupted. */
export function isRunning(status: ThreadStatus): boolean {
  return status === "active" || status === "starting" || status === "stopping";
}

const WATCH_RESULTS: Readonly<Record<WatchResult, string>> = {
  never: "not run yet",
  silent: "nothing new",
  queued: "waiting for the first mate",
  dropped: "dropped before the first mate could take it",
  delivered: "sent to the first mate",
  failed: "failed",
  invalid: "cannot run",
};

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One line on how a watch stands: "off · ran 5m ago · nothing new". */
export function watchStatusText(watch: WatchSummary, now: number = Date.now()): string {
  const parts: string[] = [];
  if (!watch.enabled) parts.push("off");
  if (watch.running) parts.push("running now");
  if (watch.lastRunAt !== null && watch.lastResult !== "invalid") parts.push(`ran ${relativeTime(watch.lastRunAt, now)}`);
  parts.push(WATCH_RESULTS[watch.lastResult]);
  return parts.join(" · ");
}

/** A pull request's address without the host: "owner/repo/pull/12". */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}
