/** A small board for the `voice.v1` tests: a captain's call with two buttons, a worker, a queued item and a landing. */
import type { BacklogItem, Fleet, FleetCard } from "../../shared/types";

export function backlogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    section: "in-flight",
    id: "fix-login",
    title: "Fix the flaky login test",
    project: "web",
    kind: null,
    mode: null,
    threadId: "thr_login",
    hold: null,
    actions: [],
    blockedBy: null,
    since: null,
    url: null,
    reportPath: null,
    outcome: null,
    ...overrides,
  };
}

export function fleetCard(overrides: Partial<FleetCard> = {}): FleetCard {
  return {
    key: "crew:thr_login",
    column: "idle",
    taskId: "fix-login",
    title: "Fix the flaky login test",
    project: "web",
    kind: null,
    backlog: null,
    crew: {
      threadId: "thr_login",
      title: "Fix the flaky login test",
      status: "idle",
      pendingInteractions: 0,
      parentNotifications: "auto",
      projectId: "prj_web",
      environmentId: "env_login",
      updatedAt: 1_000,
      task: "fix-login",
      kind: null,
      project: "web",
    },
    report: null,
    url: null,
    ...overrides,
  };
}

export const MERGE_PROMPT = "Merge https://github.com/you/web/pull/42";
export const HOLD_PROMPT = "Leave https://github.com/you/web/pull/42 open until I say";

export function voiceFleet(overrides: Partial<Fleet> = {}): Fleet {
  const call = fleetCard({
    backlog: backlogItem({
      hold: "merge web#42?",
      url: "https://github.com/you/web/pull/42",
      actions: [
        { label: "Merge", prompt: MERGE_PROMPT },
        { label: "Hold", prompt: HOLD_PROMPT },
      ],
    }),
    report: { state: "done", text: "PR https://github.com/you/web/pull/42 checks green" },
    url: "https://github.com/you/web/pull/42",
  });
  const worker = fleetCard({
    key: "crew:thr_dark",
    column: "working",
    taskId: "dark-mode",
    title: "Add dark mode",
    crew: { ...fleetCard().crew!, threadId: "thr_dark", title: "Add dark mode", status: "active", task: "dark-mode" },
    report: { state: "working", text: "running the UI tests" },
  });
  const queued = fleetCard({
    key: "backlog:queued:date-lib:3",
    column: "queued",
    taskId: "date-lib",
    title: "Upgrade the date library",
    crew: null,
    backlog: backlogItem({ section: "queued", id: "date-lib", title: "Upgrade the date library", threadId: null, blockedBy: "dark-mode" }),
  });
  const landed = fleetCard({
    key: "backlog:done:typo:4",
    column: "done",
    taskId: "typo",
    title: "Fix the typo",
    crew: null,
    backlog: backlogItem({ section: "done", id: "typo", title: "Fix the typo", threadId: null, outcome: "merged 2026-11-12" }),
  });
  return {
    home: "/home/fm",
    homeReady: true,
    mate: { threadId: "thr_mate", status: "idle", title: "First mate" },
    mateMissing: false,
    cards: [call, worker, queued, landed],
    suggestions: [
      { label: "Review loop on web#42", prompt: "Run a review loop on https://github.com/you/web/pull/42" },
      { label: "Land web#42", prompt: "Land https://github.com/you/web/pull/42" },
    ],
    charter: { edited: false, outdated: false },
    watches: [],
    ...overrides,
  };
}
