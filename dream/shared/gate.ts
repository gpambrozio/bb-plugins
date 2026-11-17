/**
 * Whether a repository is due a dream, from facts the host gathered. Pure, so the thresholds are
 * tested without files. Native auto-dream (Claude Code 2.1.326) dreams after 24 hours and 5 sessions
 * in the current folder; this plugin's defaults are stricter and count every folder of the repository:
 *
 * - at least `minHours` since the last dream (the lock's mtime);
 * - at least `minSessions` sessions since then, on at least `minDays` distinct days, so a burst of
 *   machine-driven sessions in one day does not trigger a dream;
 * - nobody working in it: no change to the memory folder and no session in the last `quietMinutes`.
 *
 * With no lock (never dreamed), the time gate passes and sessions count from the memory folder's
 * newest change, since the memory already holds what came before it.
 */
import { z } from "zod";

export const ThresholdsSchema = z.object({
  minHours: z.number().min(0),
  minSessions: z.number().int().min(0),
  minDays: z.number().int().min(0),
  quietMinutes: z.number().min(0),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = { minHours: 72, minSessions: 5, minDays: 2, quietMinutes: 30 };

export const GATE_CODES = [
  "due",
  "off",
  "no-checkout",
  "no-memory",
  "auto-memory-off",
  "proposal-pending",
  "locked",
  "too-soon",
  "too-few-sessions",
  "too-few-days",
  "memory-busy",
  "session-busy",
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export interface GateSession {
  sessionId: string;
  mtimeMs: number;
}

export interface GateInput<S extends GateSession = GateSession> {
  now: number;
  enabled: boolean;
  thresholds: Thresholds;
  memory: { mdCount: number; newestChangeMs: number | null; autoMemoryEnabled: boolean };
  /** `lastConsolidatedAt` is the lock's mtime, 0 when there is no lock. */
  lock: { lastConsolidatedAt: number; held: boolean };
  /** Every session of the repository, dream threads' own already left out. */
  sessions: readonly S[];
  /** The pending dry run's time, when one waits to be applied or discarded. */
  pendingProposal: string | null;
  /** The calendar day of a time, for counting distinct days; local time by default. */
  dayKey?: (ms: number) => string;
}

export interface GateResult<S extends GateSession = GateSession> {
  due: boolean;
  code: GateCode;
  reason: string;
  lastDreamAt: number | null;
  /** Sessions count from here: the last dream, else the memory folder's newest change. */
  baselineAt: number | null;
  sessionsSince: number;
  daysSince: number;
  /** The sessions since the baseline, newest first. */
  since: S[];
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function hours(ms: number): string {
  const value = ms / HOUR;
  return value >= 10 ? `${Math.floor(value)} h` : `${value.toFixed(1)} h`;
}

export function evaluateGate<S extends GateSession>(input: GateInput<S>): GateResult<S> {
  const { now, thresholds, memory, lock } = input;
  const dayKey = input.dayKey ?? localDayKey;
  const lastDreamAt = lock.lastConsolidatedAt > 0 ? lock.lastConsolidatedAt : null;
  const baselineAt = lastDreamAt ?? memory.newestChangeMs;
  const since = input.sessions
    .filter((session) => baselineAt === null || session.mtimeMs > baselineAt)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const days = new Set(since.map((session) => dayKey(session.mtimeMs))).size;
  const base = { lastDreamAt, baselineAt, sessionsSince: since.length, daysSince: days, since };
  const result = (code: GateCode, reason: string): GateResult<S> => ({ ...base, due: code === "due", code, reason });

  if (!input.enabled) return result("off", "Turned off for this project.");
  if (memory.mdCount === 0) return result("no-memory", "Its memory folder has no .md files.");
  if (!memory.autoMemoryEnabled) return result("auto-memory-off", "Claude Code's auto memory is turned off for it.");
  if (input.pendingProposal !== null) {
    return result("proposal-pending", `A dry-run proposal from ${input.pendingProposal} waits to be applied or discarded.`);
  }
  if (lock.held) return result("locked", "Another dream holds its memory lock.");
  if (lastDreamAt !== null && now - lastDreamAt < thresholds.minHours * HOUR) {
    return result("too-soon", `Last dream ${hours(now - lastDreamAt)} ago; needs ${thresholds.minHours} h.`);
  }
  if (since.length < thresholds.minSessions) {
    return result("too-few-sessions", `${plural(since.length, "session")} since; needs ${thresholds.minSessions}.`);
  }
  if (days < thresholds.minDays) {
    return result("too-few-days", `${plural(since.length, "session")} on ${plural(days, "day")}; needs ${plural(thresholds.minDays, "day")}.`);
  }
  const quiet = thresholds.quietMinutes * MINUTE;
  if (memory.newestChangeMs !== null && now - memory.newestChangeMs < quiet) {
    return result("memory-busy", `Its memory changed in the last ${thresholds.quietMinutes} minutes; someone is working in it.`);
  }
  const newestSession = input.sessions.reduce((newest, session) => Math.max(newest, session.mtimeMs), 0);
  if (newestSession > 0 && now - newestSession < quiet) {
    return result("session-busy", `A session ran in the last ${thresholds.quietMinutes} minutes; someone is working in it.`);
  }
  return result("due", `${plural(since.length, "session")} on ${plural(days, "day")} since ${lastDreamAt === null ? "its memory last changed" : "the last dream"}.`);
}

/** Codes that a dream started by hand still refuses. */
export const MANUAL_REFUSALS: ReadonlySet<GateCode> = new Set(["no-checkout", "no-memory", "locked", "proposal-pending"]);

export interface Candidate {
  projectId: string;
  gate: Pick<GateResult, "due" | "lastDreamAt" | "baselineAt">;
}

/**
 * The most overdue due repository: never dreamed before any that has, then the oldest last dream,
 * then the oldest baseline. Null when none is due.
 */
export function mostOverdue<T extends Candidate>(candidates: readonly T[]): T | null {
  const due = candidates.filter((candidate) => candidate.gate.due);
  due.sort((a, b) => {
    const lastA = a.gate.lastDreamAt ?? -1;
    const lastB = b.gate.lastDreamAt ?? -1;
    if (lastA !== lastB) return lastA - lastB;
    return (a.gate.baselineAt ?? 0) - (b.gate.baselineAt ?? 0) || a.projectId.localeCompare(b.projectId);
  });
  return due[0] ?? null;
}
