import { describe, expect, it } from "vitest";

import { afterAnswer, BACKOFF_MS, canStartByHand, DAY, decideOffer, HOUR, isHumanThread, projectKey, SNOOZE_MS, snoozeAfterLater, type OfferInputs } from "./policy";
import type { Candidate } from "./signals";
import { settingsWith } from "./testing/store";

const NOW = 10 * DAY;
const commit: Candidate = { trigger: "commit", topic: '"Add retries"', refs: {} };
const files: Candidate = { trigger: "new-files", topic: "the new `a.ts`", refs: {} };

function inputs(overrides: Partial<OfferInputs> = {}): OfferInputs {
  return {
    now: NOW,
    settings: settingsWith(),
    projectNever: false,
    thread: { optOut: false, finishedSessions: 0, openSession: false, snoozeUntil: null, snoozeUntilTurn: null, completedTurns: 4 },
    turnCompleted: true,
    interactionPending: false,
    sessionActiveInProject: false,
    global: { seenAt: [], consecutiveLaters: 0, backoffUntil: null },
    candidates: [commit, files],
    ...overrides,
  };
}

describe("isHumanThread", () => {
  const human = { parentThreadId: null, originPluginId: null, lifecycleOwnerThreadId: null, visibility: "visible", archivedAt: null };

  it("takes a top-level thread a person drives", () => {
    expect(isHumanThread(human)).toBe(true);
  });

  it.each([
    ["a child (crew) thread", { parentThreadId: "thr_parent" }],
    ["a plugin's thread (automation, side chat, diff-review run, our own session)", { originPluginId: "side-chat" }],
    ["a delegated thread", { lifecycleOwnerThreadId: "thr_owner" }],
    ["a hidden worker", { visibility: "hidden" }],
    ["an archived thread", { archivedAt: 5 }],
  ])("refuses %s", (_name, change) => {
    expect(isHumanThread({ ...human, ...change })).toBe(false);
  });
});

describe("canStartByHand", () => {
  const human = { parentThreadId: null, originPluginId: null, lifecycleOwnerThreadId: null, visibility: "visible", archivedAt: null };

  it.each([
    ["a top-level thread a person drives", {}],
    ["a child (sub-agent) thread", { parentThreadId: "thr_parent" }],
    ["a crew thread another plugin spawned", { parentThreadId: "thr_mate", originPluginId: "firstmate-crew" }],
    ["a delegated thread", { lifecycleOwnerThreadId: "thr_owner" }],
  ])("takes %s", (_name, change) => {
    expect(canStartByHand({ ...human, ...change })).toBe(true);
  });

  it.each([
    ["this plugin's own session thread", { originPluginId: "learning-exercises" }],
    ["a hidden worker", { visibility: "hidden" }],
    ["an archived thread", { archivedAt: 5 }],
  ])("refuses %s", (_name, change) => {
    expect(canStartByHand({ ...human, ...change })).toBe(false);
  });
});

describe("decideOffer", () => {
  it("offers the highest-priority candidate when nothing stands in the way", () => {
    expect(decideOffer(inputs())).toEqual({ offer: commit });
  });

  it.each<[string, Partial<OfferInputs>]>([
    ["offers are off", { settings: settingsWith({ offersEnabled: false }) }],
    ["never for this project", { projectNever: true }],
    ["off for this thread", { thread: { ...inputs().thread, optOut: true } }],
    ["the turn did not complete", { turnCompleted: false }],
    ["a question is waiting for the user", { interactionPending: true }],
    ["a session is open for this thread", { thread: { ...inputs().thread, openSession: true } }],
    ["a session is running in this project", { sessionActiveInProject: true }],
    ["this thread had its sessions", { thread: { ...inputs().thread, finishedSessions: 2 } }],
    ["nothing to offer", { candidates: [] }],
  ])("skips when %s", (reason, change) => {
    expect(decideOffer(inputs(change))).toEqual({ skip: reason });
  });

  it("follows the per-thread session cap setting", () => {
    const thread = { ...inputs().thread, finishedSessions: 2 };
    expect(decideOffer(inputs({ thread, settings: settingsWith({ sessionsPerThread: 3 }) }))).toEqual({ offer: commit });
  });

  describe("Later's snooze", () => {
    it("holds until both 45 minutes and 3 completed turns have passed", () => {
      const snooze = snoozeAfterLater(NOW, 4);
      expect(snooze).toEqual({ snoozeUntil: NOW + SNOOZE_MS, snoozeUntilTurn: 7 });
      const at = (now: number, completedTurns: number) => decideOffer(inputs({ now, thread: { ...inputs().thread, ...snooze, completedTurns } }));
      expect(at(NOW + SNOOZE_MS - 1, 10)).toEqual({ skip: "snoozed" });
      expect(at(NOW + SNOOZE_MS, 6)).toEqual({ skip: "snoozed" });
      expect(at(NOW + SNOOZE_MS, 7)).toEqual({ offer: commit });
    });
  });

  describe("global caps count seen offers", () => {
    it("stops at the daily limit, counted over the last 24 hours", () => {
      const seenAt = [NOW - 20 * HOUR, NOW - 10 * HOUR, NOW - 3 * HOUR];
      expect(decideOffer(inputs({ global: { seenAt, consecutiveLaters: 0, backoffUntil: null } }))).toEqual({ skip: "the daily limit is reached" });
      const older = [NOW - 25 * HOUR, NOW - 10 * HOUR, NOW - 3 * HOUR];
      expect(decideOffer(inputs({ global: { seenAt: older, consecutiveLaters: 0, backoffUntil: null } }))).toEqual({ offer: commit });
    });

    it("keeps two hours between seen offers", () => {
      const global = (lastSeen: number) => ({ seenAt: [lastSeen], consecutiveLaters: 0, backoffUntil: null });
      expect(decideOffer(inputs({ global: global(NOW - 2 * HOUR + 1) }))).toEqual({ skip: "too soon after the last offer" });
      expect(decideOffer(inputs({ global: global(NOW - 2 * HOUR) }))).toEqual({ offer: commit });
      expect(decideOffer(inputs({ global: global(NOW - HOUR), settings: settingsWith({ hoursBetweenOffers: 0 }) }))).toEqual({ offer: commit });
    });
  });

  describe("back-off", () => {
    it("after three Laters in a row keeps only commits and merged pull requests for 7 days", () => {
      let global = { seenAt: [] as number[], consecutiveLaters: 0, backoffUntil: null as number | null };
      for (let i = 0; i < 3; i += 1) global = { ...global, ...afterAnswer(global, "later", NOW) };
      expect(global).toEqual({ seenAt: [], consecutiveLaters: 0, backoffUntil: NOW + BACKOFF_MS });
      expect(decideOffer(inputs({ global, candidates: [files] }))).toEqual({ skip: "backing off" });
      expect(decideOffer(inputs({ global, candidates: [files, commit] }))).toEqual({ offer: commit });
      expect(decideOffer(inputs({ global, candidates: [files], now: NOW + BACKOFF_MS }))).toEqual({ offer: files });
    });

    it("a Start breaks the run of Laters; other answers leave it", () => {
      const two = { seenAt: [], consecutiveLaters: 2, backoffUntil: null };
      expect(afterAnswer(two, "start", NOW)).toEqual({ consecutiveLaters: 0, backoffUntil: null });
      expect(afterAnswer(two, "other", NOW)).toEqual({ consecutiveLaters: 2, backoffUntil: null });
    });
  });
});

describe("projectKey", () => {
  it("is the same for every spelling of one remote", () => {
    const keys = [
      "git@github.com:Acme/Calc.git",
      "https://github.com/acme/calc",
      "https://github.com/acme/calc.git",
      "ssh://git@github.com/acme/calc.git",
      "https://user@github.com/acme/calc/",
    ].map((gitRemoteUrl) => projectKey({ id: "proj_x", gitRemoteUrl }));
    expect(new Set(keys)).toEqual(new Set(["remote:github.com/acme/calc"]));
  });

  it("falls back to the project id without a remote", () => {
    expect(projectKey({ id: "proj_x", gitRemoteUrl: null })).toBe("project:proj_x");
    expect(projectKey({ id: "proj_x", gitRemoteUrl: "  " })).toBe("project:proj_x");
  });
});
