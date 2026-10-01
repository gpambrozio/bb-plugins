import { describe, expect, it } from "vitest";

import type { Job } from "../shared/jobs";
import { draftFrom, duration, relativeTime, schedulePreview, specFrom, statusOf, type Draft } from "./format";

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "backup",
    label: "com.paseo-plugins.launchd-jobs.backup",
    name: "Backup",
    command: "echo hi",
    cwd: null,
    schedule: { type: "interval", seconds: 3600, description: "Every hour" },
    managed: true,
    dataDir: "/data",
    adopted: false,
    readOnlyData: false,
    loaded: true,
    disabled: false,
    running: false,
    pid: null,
    runs: 1,
    lastExitCode: 0,
    recentRuns: [],
    plistPath: "/agents/backup.plist",
    logPath: "/data/logs/backup.log",
    problem: null,
    ...patch,
  };
}

const run = (exitCode: number) => ({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", exitCode, durationMs: 1000 });

describe("statusOf", () => {
  it("puts an unreadable plist first, then launchd's view, then the last recorded run", () => {
    expect(statusOf(job({ problem: "bad", disabled: true }))).toEqual({ label: "Unreadable", tone: "danger" });
    expect(statusOf(job({ disabled: true, loaded: false }))).toEqual({ label: "Disabled", tone: "muted" });
    expect(statusOf(job({ loaded: false }))).toEqual({ label: "Not loaded", tone: "danger" });
    expect(statusOf(job({ running: true, recentRuns: [run(1)] }))).toEqual({ label: "Running", tone: "running" });
    expect(statusOf(job({ recentRuns: [run(2)] }))).toEqual({ label: "Failed (exit 2)", tone: "danger" });
    expect(statusOf(job({ recentRuns: [run(0)], lastExitCode: 9 }))).toEqual({ label: "OK", tone: "muted" });
  });

  it("falls back to launchd's exit code for a job with no recorded runs", () => {
    expect(statusOf(job({ lastExitCode: 78 }))).toEqual({ label: "Failed (exit 78)", tone: "danger" });
    expect(statusOf(job({ lastExitCode: null }))).toEqual({ label: "Never run", tone: "muted" });
  });
});

describe("drafts", () => {
  it("round-trips a job's interval into the largest whole unit", () => {
    expect(draftFrom(job())).toMatchObject({ mode: "interval", every: "1", unit: "hours" });
    expect(draftFrom(job({ schedule: { type: "interval", seconds: 90, description: "" } }))).toMatchObject({ every: "90", unit: "seconds" });
  });

  it("turns a draft into a spec, or names the first thing wrong with it", () => {
    const draft: Draft = { name: " Backup ", command: "echo hi", cwd: " ", mode: "cron", expression: "0 9 * * 1-5", every: "30", unit: "minutes" };
    expect(specFrom(draft)).toEqual({
      ok: true,
      spec: { name: "Backup", command: "echo hi", cwd: null, schedule: { type: "cron", expression: "0 9 * * 1-5" } },
    });
    expect(specFrom({ ...draft, name: "" })).toEqual({ ok: false, error: "Give the job a name" });
    expect(specFrom({ ...draft, mode: "interval", every: "-1" })).toEqual({ ok: false, error: "The interval must be a positive number" });
    expect(specFrom({ ...draft, mode: "interval", every: "1.5" })).toMatchObject({ ok: true, spec: { schedule: { type: "interval", seconds: 90 } } });
  });

  it("previews a schedule in words, with its launchd entry count", () => {
    const draft = draftFrom(null);
    expect(schedulePreview(draft)).toEqual({ ok: true, text: "At 09:00 on Mon–Fri · 5 launchd entries" });
    expect(schedulePreview({ ...draft, expression: "nonsense" }).ok).toBe(false);
  });
});

describe("times", () => {
  it("reads durations and ages the way the list shows them", () => {
    expect(duration(250)).toBe("250 ms");
    expect(duration(1500)).toBe("1.5 s");
    expect(duration(125_000)).toBe("2 min 5 s");
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T23:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-01-01T23:00:00Z", now)).toBe("1 h ago");
    expect(relativeTime("2026-01-01T00:00:00Z", now)).toBe("yesterday");
  });
});
