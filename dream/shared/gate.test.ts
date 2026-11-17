import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS, evaluateGate, mostOverdue, type GateInput, type GateSession } from "./gate";
import { inWindow, parseClock, windowClosesAt, windowOpensAt } from "./window";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function sessions(...agesInHours: number[]): GateSession[] {
  return agesInHours.map((age, index) => ({ sessionId: `s${index}`, mtimeMs: NOW - age * HOUR }));
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    enabled: true,
    thresholds: DEFAULT_THRESHOLDS,
    memory: { mdCount: 4, newestChangeMs: NOW - 10 * DAY, autoMemoryEnabled: true },
    lock: { lastConsolidatedAt: NOW - 4 * DAY, held: false },
    sessions: sessions(2, 5, 30, 50, 70),
    pendingProposal: null,
    dayKey: utcDay,
    ...overrides,
  };
}

describe("evaluateGate", () => {
  it("is due after 72 h and 5 sessions on 2 days", () => {
    const result = evaluateGate(input());
    expect(result).toMatchObject({ due: true, code: "due", sessionsSince: 5, daysSince: 4, lastDreamAt: NOW - 4 * DAY });
    expect(result.since.map((session) => session.sessionId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("is too soon before 72 h", () => {
    expect(evaluateGate(input({ lock: { lastConsolidatedAt: NOW - 71 * HOUR, held: false } }))).toMatchObject({ due: false, code: "too-soon" });
  });

  it("counts only sessions newer than the last dream", () => {
    const result = evaluateGate(input({ sessions: [...sessions(2, 5, 30, 50), { sessionId: "old", mtimeMs: NOW - 5 * DAY }] }));
    expect(result).toMatchObject({ due: false, code: "too-few-sessions", sessionsSince: 4 });
  });

  it("is not due for a burst of sessions within one day", () => {
    const burst = Array.from({ length: 140 }, (_, index) => ({ sessionId: `b${index}`, mtimeMs: Date.UTC(2026, 10, 15, 1, index % 60) }));
    const result = evaluateGate(input({ sessions: burst }));
    expect(result).toMatchObject({ due: false, code: "too-few-days", sessionsSince: 140, daysSince: 1 });
  });

  it("follows configured thresholds", () => {
    const result = evaluateGate(input({ thresholds: { minHours: 24, minSessions: 2, minDays: 1, quietMinutes: 30 }, sessions: sessions(2, 5) }));
    expect(result.due).toBe(true);
  });

  it("skips a repository whose memory changed in the last 30 minutes", () => {
    const result = evaluateGate(input({ memory: { mdCount: 4, newestChangeMs: NOW - 29 * 60_000, autoMemoryEnabled: true } }));
    expect(result).toMatchObject({ due: false, code: "memory-busy" });
  });

  it("skips a repository with a session in the last 30 minutes", () => {
    const result = evaluateGate(input({ sessions: [...sessions(2, 5, 30, 50, 70), { sessionId: "live", mtimeMs: NOW - 10 * 60_000 }] }));
    expect(result).toMatchObject({ due: false, code: "session-busy" });
  });

  it("is due again 30 minutes after the last change", () => {
    const result = evaluateGate(input({ memory: { mdCount: 4, newestChangeMs: NOW - 31 * 60_000, autoMemoryEnabled: true }, lock: { lastConsolidatedAt: 0, held: false }, sessions: [] }));
    expect(result.code).toBe("too-few-sessions");
    const quiet = evaluateGate(input({ sessions: sessions(0.6, 5, 30, 50, 70) }));
    expect(quiet.due).toBe(true);
  });

  it("counts from the memory folder's newest change when it has never dreamed", () => {
    const result = evaluateGate(input({ lock: { lastConsolidatedAt: 0, held: false }, memory: { mdCount: 4, newestChangeMs: NOW - 40 * HOUR, autoMemoryEnabled: true } }));
    expect(result).toMatchObject({ due: false, code: "too-few-sessions", sessionsSince: 3, lastDreamAt: null, baselineAt: NOW - 40 * HOUR });
  });

  it("skips a repository with no memory files, a pending proposal, a held lock, or its switch off", () => {
    expect(evaluateGate(input({ memory: { mdCount: 0, newestChangeMs: null, autoMemoryEnabled: true } })).code).toBe("no-memory");
    expect(evaluateGate(input({ pendingProposal: "20261116T010500Z" })).code).toBe("proposal-pending");
    expect(evaluateGate(input({ lock: { lastConsolidatedAt: NOW - 10 * 60_000, held: true } })).code).toBe("locked");
    expect(evaluateGate(input({ enabled: false })).code).toBe("off");
    expect(evaluateGate(input({ memory: { mdCount: 3, newestChangeMs: null, autoMemoryEnabled: false } })).code).toBe("auto-memory-off");
  });
});

describe("mostOverdue", () => {
  const candidate = (projectId: string, due: boolean, lastDreamAt: number | null, baselineAt: number | null = null) => ({
    projectId,
    gate: { due, lastDreamAt, baselineAt },
  });

  it("picks the due repository whose last dream is oldest, never-dreamed first", () => {
    const picked = mostOverdue([candidate("a", true, NOW - 4 * DAY), candidate("b", true, NOW - 9 * DAY), candidate("c", false, NOW - 30 * DAY)]);
    expect(picked?.projectId).toBe("b");
    expect(mostOverdue([candidate("a", true, NOW - 9 * DAY), candidate("n", true, null, NOW - DAY)])?.projectId).toBe("n");
    expect(mostOverdue([candidate("a", false, null)])).toBeNull();
  });
});

describe("the window", () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 17, hours, minutes);

  it("is open from the start up to, not including, the end", () => {
    expect(parseClock("01:00")).toBe(60);
    expect(parseClock("1:00")).toBeNull();
    expect(inWindow(at(0, 59), "01:00", "06:00")).toBe(false);
    expect(inWindow(at(1, 0), "01:00", "06:00")).toBe(true);
    expect(inWindow(at(5, 59), "01:00", "06:00")).toBe(true);
    expect(inWindow(at(6, 0), "01:00", "06:00")).toBe(false);
  });

  it("crosses midnight when the end is before the start", () => {
    expect(inWindow(at(23), "22:00", "04:00")).toBe(true);
    expect(inWindow(at(3), "22:00", "04:00")).toBe(true);
    expect(inWindow(at(12), "22:00", "04:00")).toBe(false);
    expect(windowClosesAt(at(23), "22:00", "04:00")).toEqual(new Date(2026, 10, 18, 4, 0));
  });

  it("is never open when start and end are the same", () => {
    expect(inWindow(at(1), "01:00", "01:00")).toBe(false);
    expect(windowOpensAt(at(1), "01:00", "01:00")).toBeNull();
  });

  it("says when it closes and next opens", () => {
    expect(windowClosesAt(at(2), "01:00", "06:00")).toEqual(at(6));
    expect(windowClosesAt(at(7), "01:00", "06:00")).toBeNull();
    expect(windowOpensAt(at(7), "01:00", "06:00")).toEqual(new Date(2026, 10, 18, 1, 0));
  });
});
