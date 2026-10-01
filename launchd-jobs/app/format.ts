/**
 * The panel's pure logic: how a job's state reads, how times read, and how a
 * form draft becomes a job spec. Kept apart from the components so it is
 * tested without rendering.
 */
import { describeCron, describeInterval, entryCount, parseCron } from "../shared/cron";
import type { Job, JobSpec } from "../shared/jobs";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export type Tone = "muted" | "running" | "danger";

/**
 * One word for the row. Precedence: a plist that could not be read, then
 * what launchd says about the label, then the last run the runner recorded,
 * then launchd's own exit code for a plist that predates the runner.
 */
export function statusOf(job: Job): { label: string; tone: Tone } {
  if (job.problem !== null) return { label: "Unreadable", tone: "danger" };
  if (job.disabled) return { label: "Disabled", tone: "muted" };
  if (!job.loaded) return { label: "Not loaded", tone: "danger" };
  if (job.running) return { label: "Running", tone: "running" };
  const last = job.recentRuns[0];
  const exit = last === undefined ? job.lastExitCode : last.exitCode;
  if (exit !== null && exit !== 0) return { label: `Failed (exit ${exit})`, tone: "danger" };
  if (exit === null) return { label: "Never run", tone: "muted" };
  return { label: "OK", tone: "muted" };
}

export type IntervalUnit = "seconds" | "minutes" | "hours";

export const UNIT_SECONDS: Record<IntervalUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

export interface Draft {
  name: string;
  command: string;
  cwd: string;
  mode: "cron" | "interval";
  expression: string;
  every: string;
  unit: IntervalUnit;
}

export function draftFrom(job: Job | null): Draft {
  const base: Draft = { name: "", command: "", cwd: "", mode: "cron", expression: "0 9 * * 1-5", every: "30", unit: "minutes" };
  if (job === null) return base;
  const draft: Draft = { ...base, name: job.name, command: job.command, cwd: job.cwd ?? "" };
  if (job.schedule.type === "cron") draft.expression = job.schedule.expression;
  if (job.schedule.type === "interval") {
    draft.mode = "interval";
    const { seconds } = job.schedule;
    const unit: IntervalUnit = seconds % 3600 === 0 ? "hours" : seconds % 60 === 0 ? "minutes" : "seconds";
    draft.unit = unit;
    draft.every = String(seconds / UNIT_SECONDS[unit]);
  }
  return draft;
}

/** The spec the draft describes, or the first thing wrong with it. */
export function specFrom(draft: Draft): { ok: true; spec: JobSpec } | { ok: false; error: string } {
  const name = draft.name.trim();
  if (name === "") return { ok: false, error: "Give the job a name" };
  const command = draft.command.trim();
  if (command === "") return { ok: false, error: "Give the job a command" };
  const cwd = draft.cwd.trim();
  let schedule: JobSpec["schedule"];
  if (draft.mode === "cron") {
    const parsed = parseCron(draft.expression);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    schedule = { type: "cron", expression: draft.expression.trim() };
  } else {
    const every = Number(draft.every);
    if (!Number.isFinite(every) || every <= 0) return { ok: false, error: "The interval must be a positive number" };
    const seconds = Math.round(every * UNIT_SECONDS[draft.unit]);
    if (seconds < 1) return { ok: false, error: "The interval must be at least a second" };
    schedule = { type: "interval", seconds };
  }
  return { ok: true, spec: { name, command, cwd: cwd === "" ? null : cwd, schedule } };
}

/** What launchd will be told, in words, as the schedule is typed. */
export function schedulePreview(draft: Draft): { ok: boolean; text: string } {
  if (draft.mode === "interval") {
    const every = Number(draft.every);
    if (!Number.isFinite(every) || every <= 0) return { ok: false, text: "Enter a positive number" };
    return { ok: true, text: describeInterval(Math.round(every * UNIT_SECONDS[draft.unit])) };
  }
  const parsed = parseCron(draft.expression);
  if (!parsed.ok) return { ok: false, text: parsed.error };
  const count = entryCount(parsed.fields);
  const suffix = count === 1 ? "" : ` · ${count} launchd entries`;
  return { ok: true, text: `${describeCron(parsed.fields)}${suffix}` };
}
