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
    global: { answeredAt: [], consecutiveLaters: 0, backoffUntil: null },
    candidates: [commit, files],
    ...overrides,
  };
}

describe("isHumanThread", () => {
  const human = { parentThreadId: null, originPluginId: null, lifecycleOwnerThreadId: null, visibility: "visible", archivedAt: null };

  const NEVER = ["automations"];

  it.each([
    ["a top-level thread a person drives", {}],
    // thr_58q9ui4bvc: a GitHub board card's thread, bb's personal workspace, a commit in its first turn.
    ["a top-level thread a plugin started (a GitHub board card)", { originPluginId: "github-board" }],
    ["a top-level diff-review run", { originPluginId: "diff-review" }],
  ])("takes %s", (_name, change) => {
    expect(isHumanThread({ ...human, ...change }, NEVER)).toBe(true);
  });

  it.each([
    ["a child (crew) thread", { parentThreadId: "thr_parent" }],
    ["a child thread a plugin started", { parentThreadId: "thr_mate", originPluginId: "firstmate-crew" }],
    ["an automation's thread (on the never-offer list)", { originPluginId: "automations" }],
    ["this plugin's own session thread", { originPluginId: "learning-exercises" }],
    ["a delegated thread", { lifecycleOwnerThreadId: "thr_owner" }],
    ["a side chat (hidden, owned)", { originPluginId: "side-chat", visibility: "hidden", lifecycleOwnerThreadId: "thr_owner" }],
    ["a hidden worker", { visibility: "hidden" }],
    ["an archived thread", { archivedAt: 5 }],
  ])("refuses %s", (_name, change) => {
    expect(isHumanThread({ ...human, ...change }, NEVER)).toBe(false);
  });

  it("refuses a plugin the user added to the list, and this plugin's own threads even when the list leaves it out", () => {
    expect(isHumanThread({ ...human, originPluginId: "github-board" }, ["automations", "github-board"])).toBe(false);
    expect(isHumanThread({ ...human, originPluginId: "automations" }, [])).toBe(true);
    expect(isHumanThread({ ...human, originPluginId: "learning-exercises" }, [])).toBe(false);
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

  describe("global caps count answered offers", () => {
    it("stops at the daily limit, counted over the last 24 hours", () => {
      const answeredAt = [NOW - 20 * HOUR, NOW - 10 * HOUR, NOW - 3 * HOUR];
      expect(decideOffer(inputs({ global: { answeredAt, consecutiveLaters: 0, backoffUntil: null } }))).toEqual({ skip: "the daily limit is reached" });
      const older = [NOW - 25 * HOUR, NOW - 10 * HOUR, NOW - 3 * HOUR];
      expect(decideOffer(inputs({ global: { answeredAt: older, consecutiveLaters: 0, backoffUntil: null } }))).toEqual({ offer: commit });
    });

    it("keeps two hours between answered offers", () => {
      const global = (lastAnswered: number) => ({ answeredAt: [lastAnswered], consecutiveLaters: 0, backoffUntil: null });
      expect(decideOffer(inputs({ global: global(NOW - 2 * HOUR + 1) }))).toEqual({ skip: "too soon after the last offer" });
      expect(decideOffer(inputs({ global: global(NOW - 2 * HOUR) }))).toEqual({ offer: commit });
      expect(decideOffer(inputs({ global: global(NOW - HOUR), settings: settingsWith({ hoursBetweenOffers: 0 }) }))).toEqual({ offer: commit });
    });
  });

  describe("back-off", () => {
    it("after three Laters in a row keeps only commits and merged pull requests for 7 days", () => {
      let global = { answeredAt: [] as number[], consecutiveLaters: 0, backoffUntil: null as number | null };
      for (let i = 0; i < 3; i += 1) global = { ...global, ...afterAnswer(global, "later", NOW) };
      expect(global).toEqual({ answeredAt: [], consecutiveLaters: 0, backoffUntil: NOW + BACKOFF_MS });
      expect(decideOffer(inputs({ global, candidates: [files] }))).toEqual({ skip: "backing off" });
      expect(decideOffer(inputs({ global, candidates: [files, commit] }))).toEqual({ offer: commit });
      expect(decideOffer(inputs({ global, candidates: [files], now: NOW + BACKOFF_MS }))).toEqual({ offer: files });
    });

    it("a Start breaks the run of Laters; other answers leave it", () => {
      const two = { answeredAt: [], consecutiveLaters: 2, backoffUntil: null };
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

describe("the never-offer plugin list", () => {
  it("defaults to automations and reads one id per line, trimmed, without repeats", () => {
    expect(settingsWith().noOfferPlugins).toEqual(["automations"]);
    expect(settingsWith({ noOfferPlugins: " automations \n\ngithub-board, reclaim\nautomations" }).noOfferPlugins).toEqual(["automations", "github-board", "reclaim"]);
    expect(settingsWith({ noOfferPlugins: "" }).noOfferPlugins).toEqual([]);
  });
});
