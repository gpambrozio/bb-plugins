/**
 * Regressions for review pass 1 of PR #95 (findings 1–9; 7 and 10 also have wiring tests in
 * `server.test.ts`, and 8 a UI test in `app/app.test.tsx`). Each failed on e54db75.
 */
import { describe, expect, it } from "vitest";

import { LearningApi } from "./api";
import { OfferEngine, type EventThread } from "./offers";
import { DAY, HOUR, MINUTE } from "./policy";
import { SessionService } from "./sessions";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { memoryStore, settingsWith } from "./testing/store";

const WORK = "thr_work";
const ASK = { type: "prediction" as const, question: "What does `mean([])` do?", files: [] };

function setup(overrides: Record<string, unknown> = {}) {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const store = memoryStore();
  let current = settingsWith(overrides);
  const settings = () => current;
  const offers = new OfferEngine({ ports, store, settings });
  const sessions = new SessionService(ports, store, settings);
  const api = new LearningApi({ ports, store, offers, sessions, settings });
  const event = (id: string, change: Partial<EventThread> = {}): EventThread => ({ ...ports.threads.get(id)!, ...change });
  let turn = 0;
  async function commitTurn(id = WORK, subject = "Add median") {
    turn += 1;
    if (!ports.threads.has(id)) ports.threads.set(id, thread({ id, environmentId: `env_${id}` }));
    const env = ports.threads.get(id)!.environmentId!;
    ports.paths.set(env, `/work/${id}`);
    const before = ports.heads.get(env) ?? `${id}-h0`;
    ports.heads.set(env, before);
    await offers.onActive(event(id, { status: "active" }));
    const after = `${before}x`;
    ports.heads.set(env, after);
    ports.commits.set(`${env}:${before}`, { commits: [{ sha: `${after}00000`, subject }], files: [] });
    ports.turns.set(id, { turnId: `t${turn}`, status: "completed" });
    ports.advance(MINUTE);
    return offers.onIdle(event(id));
  }
  const start = (id = WORK) => sessions.start({ sourceThreadId: id, topic: '"Add median"', trigger: "commit", refs: {}, offerId: null });
  return { ports, store, offers, sessions, api, event, commitTurn, start, setSettings: (next: Record<string, unknown>) => (current = settingsWith(next)) };
}

describe("finding 1: the caps hold when a queued offer becomes visible", () => {
  it("of four offers made in quiet threads, only the first one claimed shows", async () => {
    const { commitTurn, offers, store, ports } = setup();
    const made = [];
    for (const id of ["thr_a", "thr_b", "thr_c", "thr_d"]) made.push(await commitTurn(id));
    expect(made.every((offer) => offer !== null)).toBe(true);
    expect(made.map((offer) => offers.claim(offer!.id))).toEqual([true, false, false, false]);
    expect(store.global(ports.now()).seenAt).toHaveLength(1);
    expect(offers.visibleOffer("thr_b")).toBeNull();
    // Two hours on, the next one may show.
    ports.advance(2 * HOUR);
    expect(offers.visibleOffer("thr_b")?.id).toBe(made[1]!.id);
  });

  it("an offer already seen stays visible and is not charged twice", async () => {
    const { commitTurn, offers, store, ports } = setup();
    const offer = await commitTurn();
    expect(offers.claim(offer!.id)).toBe(true);
    expect(offers.claim(offer!.id)).toBe(true);
    expect(offers.visibleOffer(WORK)?.id).toBe(offer!.id);
    expect(store.global(ports.now()).seenAt).toHaveLength(1);
  });

  it("an unseen offer does not show once a session runs elsewhere in the project", async () => {
    const { commitTurn, offers, ports, start } = setup();
    ports.threads.set("thr_b", thread({ id: "thr_b" }));
    const offer = await commitTurn();
    await start("thr_b");
    expect(offers.visibleOffer(WORK)).toBeNull();
    expect(offers.claim(offer!.id)).toBe(false);
  });
});

describe("finding 2: concurrent calls reserve before they await", () => {
  it("two Starts at once make one session and one fork", async () => {
    const { start, ports, store } = setup();
    const results = await Promise.allSettled([start(), start()]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(ports.forks).toHaveLength(1);
    expect(store.sessionsInState(["starting", "active", "awaiting-answer", "paused"])).toHaveLength(1);
  });

  it("the database refuses a second open session for one source thread", () => {
    const { store } = setup();
    const input = { mode: "fork" as const, projectKey: "k", projectId: "p", sourceThreadId: WORK, topic: "t", trigger: "manual" as const, refs: {}, offerId: null, briefVersion: "v", now: 1 };
    store.createSession(input);
    expect(() => store.createSession(input)).toThrow(/UNIQUE/);
  });

  it("two asks at once open one card, and Pause cancels it", async () => {
    const { start, ports, sessions, store } = setup();
    const { threadId, sessionId } = await start();
    const asks = [sessions.ask(threadId, ASK, "tool"), sessions.ask(threadId, ASK, "tool")];
    const settled = Promise.allSettled(asks);
    await flush();
    expect(ports.cards).toHaveLength(1);
    sessions.pause(sessionId, "user");
    const results = await settled;
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(store.session(sessionId)?.state).toBe("paused");
    expect(store.exercises(sessionId)).toHaveLength(1);
  });

  it("two Resumes at once reopen the question once", async () => {
    const { start, ports, sessions } = setup();
    const { threadId, sessionId } = await start();
    const asked = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.cancel("timeout");
    await asked;
    const results = await Promise.allSettled([sessions.resume(sessionId), sessions.resume(sessionId)]);
    await flush();
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(ports.cards).toHaveLength(2);
  });
});

describe("finding 3: Start never overwrites a newer state", () => {
  it("a fork that asks before fork() returns keeps its card, and a reload then pauses it", async () => {
    const { ports, sessions, store, start } = setup();
    let asked: Promise<string> | null = null;
    ports.duringFork = async (forkId) => {
      asked = sessions.ask(forkId, ASK, "tool");
      await flush();
    };
    const { sessionId } = await start();
    expect(asked).not.toBeNull();
    expect(store.session(sessionId)?.state).toBe("awaiting-answer");
    sessions.dispose();
    new SessionService(ports, store, () => settingsWith()).pauseOrphanedCards();
    expect(store.session(sessionId)?.state).toBe("paused");
  });

  it("a reload while the fork is pending: the old Start does not revive the session, and Resume finds the fork", async () => {
    const { ports, store, sessions, start } = setup();
    let release!: () => void;
    ports.duringFork = () => new Promise<void>((resolve) => (release = resolve));
    const starting = start();
    await flush();
    const [session] = store.sessionsInState(["starting"]);
    const next = new SessionService(ports, store, () => settingsWith());
    next.pauseOrphanedCards();
    sessions.dispose();
    release();
    await expect(starting).rejects.toThrow("reloaded");
    expect(store.session(session!.id)).toMatchObject({ state: "paused", threadId: null });
    await next.resume(session!.id);
    expect(store.session(session!.id)).toMatchObject({ state: "active", threadId: "thr_fork1" });
    expect(ports.sends.at(-1)).toMatchObject({ threadId: "thr_fork1", visible: "Resumed the learning session." });
  });

  it("a paused session stays paused when Start finishes afterwards", async () => {
    const { ports, store, sessions, start } = setup();
    ports.duringFork = async () => {
      const [session] = store.sessionsInState(["starting"]);
      sessions.pause(session!.id, "user");
    };
    const { sessionId } = await start();
    expect(store.session(sessionId)?.state).toBe("paused");
  });
});

describe("finding 4: an existing offer follows the opt-outs and its age", () => {
  it.each([
    ["offers turned off", (s: ReturnType<typeof setup>) => s.setSettings({ offersEnabled: false })],
    ["the project marked Never", (s: ReturnType<typeof setup>) => s.api.setProjectNever({ threadId: WORK, never: true })],
    ["the thread opted out", (s: ReturnType<typeof setup>) => s.api.setThreadOffers({ threadId: WORK, on: false })],
    ["a day passing before the hourly sweep", (s: ReturnType<typeof setup>) => s.ports.advance(DAY)],
  ])("is gone after %s, and cannot be answered", async (_name, change) => {
    const s = setup();
    const offer = await s.commitTurn();
    expect(s.offers.claim(offer!.id)).toBe(true);
    await change(s);
    expect((await s.api.threadView({ threadId: WORK })).offer).toBeNull();
    await expect(s.offers.answer(offer!.id, "start")).rejects.toThrow("no longer open");
  });
});

describe("finding 5: a merge the hourly read sees mid-turn is not lost", () => {
  it("is offered when the turn ends", async () => {
    const { ports, offers, event, setSettings } = setup();
    setSettings({ triggerCommit: false });
    ports.pulls.set("env_1", { url: "https://github.com/acme/calc/pull/7", title: "Retry turns", state: "open" });
    ports.turns.set(WORK, { turnId: "t0", status: "completed" });
    await offers.onActive(event(WORK, { status: "active" }));
    await offers.onIdle(event(WORK));
    // The next turn is running when the hourly read sees the merge.
    await offers.onActive(event(WORK, { status: "active" }));
    ports.threads.set(WORK, { ...ports.threads.get(WORK)!, status: "active" });
    ports.pulls.set("env_1", { url: "https://github.com/acme/calc/pull/7", title: "Retry turns", state: "merged" });
    expect(await offers.checkPullRequests()).toBe(0);
    ports.threads.set(WORK, { ...ports.threads.get(WORK)!, status: "idle" });
    ports.turns.set(WORK, { turnId: "t1", status: "completed" });
    expect(await offers.onIdle(event(WORK))).toMatchObject({ trigger: "pr-merged", topic: '"Retry turns"' });
  });
});

describe("finding 6: a card that fails or is aborted leaves a resumable pause", () => {
  it("a card that cannot open pauses the session, and Resume shows the question", async () => {
    const { ports, store, sessions, start } = setup();
    const { threadId, sessionId } = await start();
    ports.cardThrows = true;
    expect(await sessions.ask(threadId, ASK, "tool")).toContain("could not be shown");
    expect(store.session(sessionId)).toMatchObject({ state: "paused", pauseReason: "the question could not be shown or was interrupted" });
    ports.cardThrows = false;
    await sessions.resume(sessionId);
    await flush();
    expect(ports.cards.at(-1)?.request.payload.question).toBe(ASK.question);
  });

  it("an aborted caller, before or after the card opened, pauses it too", async () => {
    for (const early of [true, false]) {
      const { store, sessions, start } = setup();
      const { threadId, sessionId } = await start();
      const controller = new AbortController();
      if (early) controller.abort();
      const asked = sessions.ask(threadId, ASK, "tool", controller.signal);
      await flush();
      controller.abort();
      expect(await asked).toContain("interrupted");
      expect(store.session(sessionId)?.state).toBe("paused");
    }
  });
});

describe("finding 7: the last-commit topic on a default branch", () => {
  it("comes from the commits the thread's turns made when nothing is ahead of the default branch", async () => {
    const { commitTurn, api, ports, store } = setup();
    await commitTurn(WORK, "Add median");
    // Without the offer (which would carry the same topic) and with nothing ahead of the default branch.
    store.expireThreadOffers(WORK);
    ports.branch.set("env_1", []);
    const { choices } = await api.topicChoices({ threadId: WORK });
    expect(choices.find((choice) => choice.id === "commit")).toMatchObject({ topic: '"Add median"' });
  });
});

describe("finding 8: a long answer is kept, not skipped", () => {
  it("records an answer over the limit cut to it, and says so", async () => {
    const { ports, store, sessions, start } = setup();
    const { threadId, sessionId } = await start();
    const asked = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "answer", answer: "x".repeat(20_001), confidence: 4 });
    expect(await asked).toContain("cut at its 20,000-character limit");
    expect(store.exercises(sessionId)[0]).toMatchObject({ skipped: false, confidence: 4 });
    expect(store.exercises(sessionId)[0]!.answer).toHaveLength(20_000);
  });

  it("an unreadable submission pauses instead of skipping", async () => {
    const { ports, store, sessions, start } = setup();
    const { threadId, sessionId } = await start();
    const asked = sessions.ask(threadId, ASK, "tool");
    await flush();
    ports.answer({ action: "dance" });
    await asked;
    expect(store.session(sessionId)?.state).toBe("paused");
    expect(store.exercises(sessionId)[0]).toMatchObject({ skipped: false });
  });
});

describe("finding 9: Start from the tab breaks the run of Laters", () => {
  it("two Laters, a tab Start, a finish and one more Later do not back off", async () => {
    const { commitTurn, offers, api, store, ports, sessions, setSettings } = setup();
    setSettings({ hoursBetweenOffers: 0, offersPerDay: 20 });
    for (const id of ["thr_a", "thr_b"]) {
      const offer = await commitTurn(id);
      await offers.answer(offer!.id, "later");
    }
    expect(store.global(ports.now()).consecutiveLaters).toBe(2);
    const { threadId } = await api.startSession({ threadId: WORK, topic: "Retries", trigger: "manual", refs: {} });
    expect(store.global(ports.now()).consecutiveLaters).toBe(0);
    await sessions.finishFromAgent(threadId, { summary: null, concepts: [] });
    const offer = await commitTurn("thr_c");
    await offers.answer(offer!.id, "later");
    expect(store.global(ports.now())).toMatchObject({ consecutiveLaters: 1, backoffUntil: null });
  });

  it("a tab Start answers the live offer through the same path, charging it once", async () => {
    const { commitTurn, api, store, ports } = setup();
    const offer = await commitTurn();
    await api.startSession({ threadId: WORK, topic: offer!.topic, trigger: "commit", refs: {} });
    expect(store.offer(offer!.id)).toMatchObject({ status: "answered" });
    expect(store.global(ports.now()).seenAt).toHaveLength(1);
  });
});
