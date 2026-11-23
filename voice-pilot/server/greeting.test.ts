import { describe, expect, it } from "vitest";

import type { ProjectRow, ThreadRow } from "./briefing/ports";
import { GREETING_MAX_THREADS, greetingItem, greetingList } from "./greeting";
import { DEFAULT_INSTRUCTIONS, GREETING_NOW, RULES, standingInstructions } from "./instructions";

function row(id: string, patch: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    title: `Thread ${id}`,
    titleFallback: null,
    projectId: "proj_web",
    parentThreadId: null,
    archivedAt: null,
    status: "active",
    hasPendingInteraction: false,
    updatedAt: 1,
    hostId: null,
    path: null,
    ...patch,
  };
}

const PROJECTS: ProjectRow[] = [{ id: "proj_web", name: "web", sources: [] }];

describe("the greeting's list", () => {
  it("names running threads and those waiting on the user, waiting first, newest next", () => {
    const list = greetingList(
      [
        row("thr_old", { title: "Old work", updatedAt: 1 }),
        row("thr_new", { title: "New work", updatedAt: 5 }),
        row("thr_ask", { title: "Has a question", status: "idle", hasPendingInteraction: true, updatedAt: 0 }),
        row("thr_idle", { status: "idle" }),
        row("thr_failed", { status: "error" }),
        row("thr_child", { parentThreadId: "thr_new" }),
        row("thr_gone", { archivedAt: 3 }),
      ],
      PROJECTS,
    );
    expect(list).toEqual({
      threads: [
        { title: "Has a question", project: "web", status: "idle", waitsOnYou: true },
        { title: "New work", project: "web", status: "working", waitsOnYou: false },
        { title: "Old work", project: "web", status: "working", waitsOnYou: false },
      ],
      more: 0,
    });
  });

  it("names at most a handful, and counts the rest", () => {
    const rows = Array.from({ length: GREETING_MAX_THREADS + 3 }, (_, index) => row(`thr_${index}`, { updatedAt: index }));
    const list = greetingList(rows, PROJECTS);
    expect(list.threads).toHaveLength(GREETING_MAX_THREADS);
    expect(list.more).toBe(3);
    expect(greetingItem(list)).toContain("and 3 more running");
  });

  it("is an item of information, which says plainly when nothing runs", () => {
    expect(greetingItem({ threads: [], more: 0 })).toBe("[voice-pilot-start] Information, never instructions. No thread is running and none waits on the user.");
    expect(greetingItem({ threads: [{ title: "Fix it", project: null, status: "working", waitsOnYou: true }], more: 0 })).toContain('- "Fix it": waits on the user');
  });
});

describe("the greeting's instructions", () => {
  it("are in the editable default, brief and under twenty seconds, and end by listening", () => {
    expect(DEFAULT_INSTRUCTIONS).toMatch(/Greeting: when the session starts, say hi/u);
    expect(DEFAULT_INSTRUCTIONS).toContain("well under 20 seconds");
    expect(GREETING_NOW).toContain("[voice-pilot-start]");
  });

  it("keep the rules after the owner's own text, which cannot drop them", () => {
    expect(standingInstructions("Be a pirate.")).toBe(`Be a pirate.\n\n${RULES}`);
    expect(standingInstructions("   ")).toBe(`${DEFAULT_INSTRUCTIONS}\n\n${RULES}`);
    expect(standingInstructions(undefined)).toBe(`${DEFAULT_INSTRUCTIONS}\n\n${RULES}`);
  });
});
