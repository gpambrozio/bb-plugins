import { describe, expect, it } from "vitest";

import type { Briefing, FirstMateBrief, ThreadBrief, ThreadDetail } from "./model";
import { BUDGET, LEVELS, THREAD_FLOOR, attempts, renderAt, renderBriefing, renderThread } from "./render";

const LONG = "This sentence says what the thread is about in some detail. A second sentence adds more. A third one goes on and on about it.";

function thread(index: number, patch: Partial<ThreadBrief> = {}): ThreadBrief {
  return {
    id: `thr_t${index}`,
    title: `Thread number ${index}`,
    projectId: `proj_${index % 4}`,
    project: `Project ${index % 4}`,
    status: "idle",
    needsUser: false,
    isFirstMate: false,
    updatedAt: 1_000 - index,
    opening: `Please do task ${index}. ${LONG}`,
    lastUser: `Also handle case ${index}. ${LONG}`,
    lastAgent: `Done with step ${index}. ${LONG}`,
    childCount: 0,
    flaggedChildren: [],
    uncheckedChildren: 0,
    ...patch,
  };
}

function tasks(count: number, prefix: string): { title: string; detail: string | null }[] {
  return Array.from({ length: count }, (_, index) => ({ title: `${prefix} task ${index} with a descriptive title`, detail: null }));
}

function firstMate(size: number): FirstMateBrief {
  return {
    threadId: "thr_t0",
    needsOwner: tasks(Math.ceil(size / 4), "Held").map((line) => ({ ...line, detail: "Which option should it take?" })),
    blocked: tasks(Math.ceil(size / 6), "Blocked").map((line) => ({ ...line, detail: "worker needs a decision" })),
    inFlight: tasks(size, "Flying"),
    queued: tasks(size, "Queued"),
    done: tasks(size * 3, "Done"),
    suggestions: ["Review the open pull request", "Start the next task"],
  };
}

function briefing(threads: number, fmSize: number | null = null): Briefing {
  return {
    generatedAt: 0,
    threads: Array.from({ length: threads }, (_, index) => thread(index, index === 0 && fmSize !== null ? { isFirstMate: true, title: "FirstMate", childCount: 5, flaggedChildren: [{ id: "thr_c", title: "Crew task", state: "needs a decision", detail: "which?" }] } : {})),
    projects: Array.from({ length: Math.min(threads, 4) }, (_, index) => ({
      id: `proj_${index}`,
      name: `Project ${index}`,
      description: `Project ${index} is a thing that does things. ${LONG}`,
      source: "AGENTS.md",
    })),
    firstMate: fmSize === null ? null : firstMate(fmSize),
    problems: [],
  };
}

describe("renderBriefing", () => {
  it("shows everything for a small briefing, with no Left out line", () => {
    const text = renderBriefing(briefing(3, 2));
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text).not.toContain("Left out");
    expect(text).toContain("FirstMate's tasks:");
    expect(text).toContain("Needs you: Held task 0 with a descriptive title (Which option should it take?).");
    expect(text).toContain("Asked: Please do task 1.");
    expect(text).toContain("User last: Also handle case 1.");
    expect(text).toContain("Agent last: Done with step 1.");
    expect(text).toContain("5 sub-threads: Crew task needs a decision (which?).");
    expect(text).toContain("- Project 1: Project 1 is a thing that does things.");
    expect(text).toContain("More on one thread: bb briefing thread <id>.");
  });

  it.each([5, 12, 30, 80, 300])("fits the budget with %i root threads and a large FirstMate backlog", (count) => {
    const text = renderBriefing(briefing(count, 40));
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text).toContain("FirstMate's tasks:");
  });

  it("says what it left out, and drops the least urgent threads last", () => {
    const text = renderBriefing(briefing(80, 40));
    expect(text).toMatch(/Left out to fit: .*older thread/);
    // The most urgent threads stay; only the tail goes.
    expect(text).toContain("[thr_t0]");
    expect(text).not.toContain("[thr_t79]");
  });

  it("drops detail in order: sentences first, then the user's messages, then whole threads' messages", () => {
    const medium = renderBriefing(briefing(12, 10));
    expect(medium).toContain("Left out to fit: messages cut to their first sentence");
    expect(medium).toContain("[thr_t11]");
  });

  it("drops the oldest threads before the questions behind held tasks and the messages of the top threads", () => {
    const data = briefing(300, 40);
    data.threads[0] = { ...data.threads[0]!, needsUser: true, lastUser: "Answer this one please." };
    const text = renderBriefing(data);
    expect(text).toContain("(Which option should it take?)");
    expect(text).toContain("User last: Answer this one please.");
    expect(text).toContain("Agent last: Done with step 0.");
    expect(text).toMatch(/Left out to fit: .*\d+ older threads/);
  });

  it("orders its attempts: detail, then the oldest threads down to the floor, then the rest", () => {
    const tried = [...attempts(20)].map(([detail, shown]) => [LEVELS.indexOf(detail), shown]);
    expect(tried.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((level) => [level, 20]));
    expect(tried.slice(5, 10)).toEqual([19, 18, 17, 16, 15].map((shown) => [4, shown]));
    expect(tried.slice(10, 13)).toEqual([5, 6, 7].map((level) => [level, THREAD_FLOOR]));
    expect(tried.at(-1)).toEqual([7, 0]);
  });

  it("keeps the user's latest message where a thread needs the user", () => {
    const data = briefing(20, 10);
    data.threads[3] = thread(3, { needsUser: true, lastUser: "Answer this one please." });
    data.threads.sort((a, b) => Number(b.needsUser) - Number(a.needsUser));
    const text = renderBriefing(data);
    expect(text).toContain("User last: Answer this one please.");
    expect(text).toContain("1 needs you");
  });

  it("shows held tasks and blockers, and says nothing when there are none", () => {
    const fm = firstMate(1);
    const text = renderBriefing({ ...briefing(1), firstMate: { ...fm, needsOwner: [], blocked: [] } });
    expect(text).toContain("Needs you: nothing.");
    expect(text).toContain("Blocked: nothing.");
    expect(text).toContain("Done recently: Done task 0 with a descriptive title; Done task 1 with a descriptive title; Done task 2 with a descriptive title.");
  });

  it("counts what a list leaves out", () => {
    const text = renderAt(briefing(1, 40), LEVELS[2]!, 1, 1);
    expect(text).toMatch(/Queued: (?:Queued task \d+ with a descriptive title; ){6}and 34 more\./);
    expect(text).toContain("Done recently (latest 3 of 120)");
  });

  it("names problems briefly", () => {
    const text = renderBriefing({ ...briefing(1), problems: ['Could not read the files of project "Alpha": host offline'] });
    expect(text).toContain('Problems: Could not read the files of project "Alpha": host offline');
  });

  it("cuts a briefing no level can fit, still fits, and keeps its closing lines", () => {
    const fm = firstMate(1);
    const huge = { ...briefing(1), firstMate: { ...fm, needsOwner: tasks(3, "Held").map((line) => ({ ...line, title: `${line.title} ${"word ".repeat(400)}` })) } };
    const text = renderBriefing(huge);
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text).toContain("…[briefing cut to fit]");
    expect(text).toMatch(/Left out to fit: .*\nMore on one thread: bb briefing thread <id>\.$/);
  });

  it("says none are blocked only when every sub-thread was checked", () => {
    const render = (patch: Partial<ThreadBrief>) => renderBriefing({ ...briefing(1), threads: [thread(0, { childCount: 2, ...patch })] });
    expect(render({})).toContain("2 sub-threads: none blocked.");
    expect(render({ uncheckedChildren: 1 })).toContain("2 sub-threads: 1 could not be checked.");
    expect(render({ uncheckedChildren: 1 })).not.toContain("none blocked");
    const flagged = render({ uncheckedChildren: 1, flaggedChildren: [{ id: "thr_c", title: "Crew task", state: "blocked", detail: null }] });
    expect(flagged).toContain("2 sub-threads: Crew task is blocked; 1 could not be checked.");
  });

  it("drops why sub-threads are blocked before the messages, and says so", () => {
    const data = briefing(12, 10);
    data.threads[0] = { ...data.threads[0]!, flaggedChildren: [{ id: "thr_c", title: "Crew task", state: "blocked", detail: "no API key" }] };
    expect(renderAt(data, LEVELS[0]!, 12, 2)).toContain("Crew task is blocked (no API key)");
    const later = renderAt(data, LEVELS[3]!, 12, 2);
    expect(later).toContain("Crew task is blocked.");
    expect(later).toMatch(/Left out to fit: .*why sub-threads are blocked/);
  });
});

describe("renderThread", () => {
  function detail(patch: Partial<ThreadDetail> = {}): ThreadDetail {
    return {
      thread: thread(1, { lastAgent: `Reply. ${LONG.repeat(20)}`, opening: `Opening. ${LONG.repeat(10)}` }),
      project: { id: "proj_1", name: "Project 1", description: LONG, source: "AGENTS.md" },
      recentUserMessages: [`Newest. ${LONG}`, `Older. ${LONG}`, `Oldest. ${LONG}`],
      children: Array.from({ length: 30 }, (_, index) => ({ id: `thr_c${index}`, title: `Child ${index}`, status: "idle", statusLine: `done: finished part ${index}`, unread: null })),
      firstMate: null,
      problems: [],
      ...patch,
    };
  }

  it("fits the budget with long messages, many sub-threads and a FirstMate backlog", () => {
    const text = renderThread(detail({ firstMate: firstMate(40) }));
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text).toContain("Opening message: Opening.");
    expect(text).toContain("User's latest messages, newest first:\n- Newest.");
    expect(text).toContain("Agent's latest reply: Reply.");
    expect(text).toMatch(/Sub-threads \(30\):/);
    expect(text).toMatch(/- and \d+ more/);
    expect(text).toContain("FirstMate's tasks:");
  });

  it("shows the most detail that fits for a short thread", () => {
    const text = renderThread(detail({ thread: thread(1), children: [] }));
    expect(text).toContain("- Oldest.");
    expect(text).toContain(`About Project 1: ${LONG}`);
  });

  it("gives a reply of about 1,500 characters whole, with nothing left out", () => {
    const reply = `${"The work went well and every check passed in the end. ".repeat(27)}The decision: ship it on Monday.`;
    expect(reply.length).toBeGreaterThan(1_400);
    const text = renderThread(detail({ thread: thread(1, { lastAgent: reply }), children: [] }));
    expect(text).toContain(`Agent's latest reply: ${reply}`);
    expect(text).not.toContain("Left out to fit");
  });

  it("gives a reply too long for one result as far as it fits, and says how much was left out", () => {
    const reply = `Start. ${"The work went well and every check passed in the end. ".repeat(120)}The decision: ship it on Monday.`;
    const text = renderThread(detail({ thread: thread(1, { lastAgent: reply }), children: [], recentUserMessages: [] }));
    expect(text.length).toBeLessThanOrEqual(BUDGET);
    expect(text.length).toBeGreaterThan(BUDGET - 200);
    expect(text).toMatch(/Left out to fit: .*the end of the agent's latest reply \(the first [\d,]+ of [\d,]+ characters are given\)/);
    const given = /Agent's latest reply: (.*)/.exec(text)?.[1] ?? "";
    expect(given.length).toBeGreaterThan(3_000);
  });

  it("gives every sub-thread and task when they fit, and names each cut when they do not", () => {
    const children = Array.from({ length: 18 }, (_, index) => ({ id: `thr_c${index}`, title: `Child ${index}`, status: "idle", statusLine: "done: ok", unread: null }));
    const roomy = renderThread(detail({ thread: thread(1), children, recentUserMessages: [] }));
    expect(roomy).toContain("Child 17");
    expect(roomy).not.toContain("Left out to fit");

    const crowded = renderThread(detail({ firstMate: firstMate(40) }));
    expect(crowded).toMatch(/Left out to fit: .*sub-threads.*some of FirstMate's tasks/);
  });

  it("marks a sub-thread whose reply was not read", () => {
    const children = [
      { id: "thr_a", title: "Read fails", status: "idle", statusLine: null, unread: "failed" as const },
      { id: "thr_b", title: "Past the cap", status: "idle", statusLine: null, unread: "over-limit" as const },
    ];
    const text = renderThread(detail({ thread: thread(1), children }));
    expect(text).toContain("- Read fails (idle) [thr_a]: its latest reply could not be read");
    expect(text).toContain("- Past the cap (idle) [thr_b]: not checked");
  });
});
