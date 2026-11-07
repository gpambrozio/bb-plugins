import { describe, expect, it } from "vitest";

import { OfferEngine, type EventThread } from "./offers";
import { DAY, HOUR, MINUTE } from "./policy";
import { FakePorts, thread } from "./testing/fake-ports";
import { memoryStore, settingsWith } from "./testing/store";

const WORK = "thr_work";

function setup(settings: Record<string, unknown> = {}) {
  const ports = new FakePorts();
  ports.threads.set(WORK, thread({ id: WORK }));
  const store = memoryStore();
  let current = settingsWith(settings);
  const engine = new OfferEngine({ ports, store, settings: () => current });
  const event = (id = WORK, overrides: Partial<EventThread> = {}): EventThread => ({ ...ports.threads.get(id)!, ...overrides });
  let turn = 0;
  /** One turn: active, then whatever `during` does (a commit, edits), then idle with a completed turn. */
  async function runTurn(during: () => void = () => {}, id = WORK, status = "completed") {
    turn += 1;
    await engine.onActive(event(id, { status: "active" }));
    during();
    ports.turns.set(id, { turnId: `t${turn}`, status });
    ports.advance(MINUTE);
    return engine.onIdle(event(id));
  }
  function commit(subject: string, files: { path: string; status: string }[] = [{ path: "src/retry.ts", status: "M" }]) {
    const before = ports.heads.get("env_1")!;
    const after = `${before}x`;
    ports.heads.set("env_1", after);
    ports.commits.set(`env_1:${before}`, { commits: [{ sha: `${after}0000`, subject }], files });
  }
  function addFile(path: string, id = WORK) {
    ports.fileChanges.set(`${id}:t${turn}`, [{ kind: "add", path: `/work/calc/${path}` }]);
  }
  return { ports, store, engine, runTurn, commit, addFile, event, setSettings: (next: Record<string, unknown>) => (current = settingsWith(next)) };
}

describe("OfferEngine", () => {
  it("offers after a turn that committed, with the commit's subject as the topic", async () => {
    const { runTurn, commit, ports, store } = setup();
    const offer = await runTurn(() => commit("Retry turns after a rate limit"));
    expect(offer).toMatchObject({ threadId: WORK, trigger: "commit", topic: '"Retry turns after a rate limit"' });
    expect(store.liveOffer(WORK)?.id).toBe(offer!.id);
    expect(ports.changes).toBeGreaterThan(0);
  });

  it("offers after new source files, from the turn's own fileChange items", async () => {
    const { runTurn, addFile } = setup();
    const offer = await runTurn(() => addFile("src/backoff.ts"));
    expect(offer).toMatchObject({ trigger: "new-files", topic: "the new `src/backoff.ts`", refs: { paths: ["src/backoff.ts"] } });
  });

  it("offers nothing after a turn that changed nothing, failed, or only touched docs", async () => {
    const { runTurn, addFile, commit } = setup();
    expect(await runTurn()).toBeNull();
    expect(await runTurn(() => addFile("NOTES.md"))).toBeNull();
    expect(await runTurn(() => commit("x"), WORK, "failed")).toBeNull();
  });

  it("does not take a neighbour's commit for this turn's (two threads in one workspace)", async () => {
    const { runTurn, commit, ports, engine, event } = setup();
    ports.threads.set("thr_other", thread({ id: "thr_other" }));
    await engine.onActive(event("thr_other", { status: "active" }));
    expect(await runTurn(() => commit("Someone else's commit"))).toBeNull();
    // Once the neighbour's turn is long over, a commit is this thread's again.
    ports.turns.set("thr_other", { turnId: "o1", status: "completed" });
    await engine.onIdle(event("thr_other"));
    ports.advance(HOUR);
    expect(await runTurn(() => commit("Mine"))).toMatchObject({ trigger: "commit" });
  });

  it("a neighbour's failed turn stops counting as overlapping once it is over", async () => {
    const { runTurn, commit, ports, engine, event } = setup();
    ports.threads.set("thr_other", thread({ id: "thr_other" }));
    await engine.onActive(event("thr_other", { status: "active" }));
    engine.threadGone("thr_other");
    ports.advance(MINUTE);
    expect(await runTurn(() => commit("Mine"))).toMatchObject({ trigger: "commit" });
  });

  it("never offers in a child, an automation's, our own or a hidden thread", async () => {
    const { ports, runTurn, commit, setSettings } = setup();
    setSettings({ hoursBetweenOffers: 0 });
    for (const [id, change] of [
      ["thr_child", { parentThreadId: WORK }],
      ["thr_plugin_child", { parentThreadId: WORK, originPluginId: "firstmate-crew" }],
      ["thr_automation", { originPluginId: "automations" }],
      ["thr_session", { originPluginId: "learning-exercises" }],
      ["thr_hidden", { visibility: "hidden" }],
    ] as const) {
      ports.threads.set(id, thread({ id, ...change }));
      expect(await runTurn(() => commit("x"), id)).toBeNull();
    }
  });

  it("offers on the first turn of a top-level thread another plugin started (thr_58q9ui4bvc, a GitHub board card)", async () => {
    // The observed case: a thread a GitHub board card started in bb's personal workspace, one turn,
    // a commit in it. bb stamps `originPluginId: "github-board"` on it; the old rule refused every
    // plugin's thread, so the turn was never weighed and nothing was recorded.
    const { ports, runTurn, commit, store } = setup();
    const id = "thr_58q9ui4bvc";
    ports.threads.set(id, thread({ id, projectId: "proj_personal", originPluginId: "github-board" }));
    const offer = await runTurn(() => commit("Address review feedback on font extraction"), id);
    expect(offer).toMatchObject({ threadId: id, trigger: "commit", topic: '"Address review feedback on font extraction"' });
    expect(store.thread(id).completedTurns).toBe(1);
  });

  it("never offers in a plugin's top-level thread once that plugin is on the never-offer list", async () => {
    const { ports, runTurn, commit, setSettings } = setup();
    setSettings({ noOfferPlugins: "automations\ngithub-board" });
    ports.threads.set("thr_board", thread({ id: "thr_board", originPluginId: "github-board" }));
    expect(await runTurn(() => commit("x"), "thr_board")).toBeNull();
    // Our own session threads stay out even when the list is emptied.
    setSettings({ noOfferPlugins: "" });
    ports.threads.set("thr_session", thread({ id: "thr_session", originPluginId: "learning-exercises" }));
    expect(await runTurn(() => commit("y"), "thr_session")).toBeNull();
    ports.threads.set("thr_automation", thread({ id: "thr_automation", originPluginId: "automations" }));
    expect(await runTurn(() => commit("z"), "thr_automation")).toMatchObject({ trigger: "commit" });
  });

  it("keeps one live offer per thread: a newer one supersedes it", async () => {
    const { runTurn, commit, store, setSettings } = setup();
    setSettings({ hoursBetweenOffers: 0 });
    const first = await runTurn(() => commit("First"));
    expect(first).not.toBeNull();
    // The next turn's start expires the unanswered offer before any new one.
    const second = await runTurn(() => commit("Second"));
    expect(second?.topic).toBe('"Second"');
    expect(store.offer(first!.id)?.status).toBe("expired");
  });

  it("an offer counts toward the caps only once answered", async () => {
    const { runTurn, commit, engine, store, ports } = setup();
    const offer = await runTurn(() => commit("First"));
    expect(store.global(ports.now()).answeredAt).toEqual([]);
    expect(engine.claim(offer!.id)).toBe(true);
    expect(engine.claim(offer!.id)).toBe(true);
    // Seen is not answered: nothing counts yet.
    expect(store.global(ports.now()).answeredAt).toEqual([]);
    await engine.answer(offer!.id, "not-thread");
    expect(store.global(ports.now()).answeredAt).toEqual([ports.now()]);
    // Answered 2 h ago at the latest: a commit an hour later is not offered.
    ports.threads.set("thr_b", thread({ id: "thr_b" }));
    ports.advance(HOUR);
    expect(await runTurn(() => commit("Later work"), "thr_b")).toBeNull();
    ports.advance(HOUR);
    expect(await runTurn(() => commit("Even later"), "thr_b")).toMatchObject({ trigger: "commit" });
  });

  it("an unseen offer never blocks another thread's", async () => {
    const { runTurn, commit, ports } = setup();
    expect(await runTurn(() => commit("A"))).not.toBeNull();
    ports.threads.set("thr_b", thread({ id: "thr_b" }));
    expect(await runTurn(() => commit("B"), "thr_b")).not.toBeNull();
  });

  it("Later snoozes the thread for 45 minutes and three completed turns", async () => {
    const { runTurn, commit, engine, ports } = setup({ hoursBetweenOffers: 0 });
    const offer = await runTurn(() => commit("A"));
    await engine.answer(offer!.id, "later");
    ports.advance(50 * MINUTE);
    expect(await runTurn(() => commit("B"))).toBeNull();
    expect(await runTurn(() => commit("C"))).toBeNull();
    expect(await runTurn(() => commit("D"))).toMatchObject({ topic: '"D"' });
  });

  it("three Laters in a row leave only commits and merged pull requests for a week", async () => {
    const { runTurn, commit, addFile, engine, ports } = setup({ hoursBetweenOffers: 0, offersPerDay: 20 });
    for (let i = 0; i < 3; i += 1) {
      ports.threads.set(`thr_${i}`, thread({ id: `thr_${i}` }));
      const offer = await runTurn(() => commit(`c${i}`), `thr_${i}`);
      await engine.answer(offer!.id, "later");
    }
    expect(await runTurn(() => addFile("src/new.ts"))).toBeNull();
    expect(await runTurn(() => commit("still offered"))).toMatchObject({ trigger: "commit" });
  });

  it("Not in this thread turns the thread off; Never for this project turns the project off", async () => {
    const { runTurn, commit, engine, store, ports } = setup({ hoursBetweenOffers: 0 });
    const offer = await runTurn(() => commit("A"));
    await engine.answer(offer!.id, "not-thread");
    expect(store.thread(WORK).optOut).toBe(true);
    expect(await runTurn(() => commit("B"))).toBeNull();
    ports.threads.set("thr_b", thread({ id: "thr_b" }));
    const other = await runTurn(() => commit("C"), "thr_b");
    await engine.answer(other!.id, "never-project");
    expect(store.neverProjects()).toEqual([{ key: "remote:github.com/acme/calc", name: "calc" }]);
    ports.threads.set("thr_c", thread({ id: "thr_c" }));
    expect(await runTurn(() => commit("D"), "thr_c")).toBeNull();
  });

  it("refuses to answer an offer that is no longer live", async () => {
    const { runTurn, commit, engine } = setup();
    const offer = await runTurn(() => commit("A"));
    await engine.answer(offer!.id, "later");
    await expect(engine.answer(offer!.id, "start")).rejects.toThrow("no longer open");
  });

  it("expires offers nobody answered within a day", async () => {
    const { runTurn, commit, engine, store, ports } = setup();
    await runTurn(() => commit("A"));
    ports.advance(DAY - 2 * MINUTE);
    expect(engine.expireOld()).toBe(0);
    ports.advance(2 * MINUTE);
    expect(engine.expireOld()).toBe(1);
    expect(store.liveOffer(WORK)).toBeNull();
  });

  it("offers when the thread's pull request merges, at idle or on the hourly read", async () => {
    const { runTurn, engine, ports } = setup({ hoursBetweenOffers: 0 });
    ports.pulls.set("env_1", { url: "https://github.com/acme/calc/pull/7", title: "Retry turns", state: "open" });
    expect(await runTurn()).toBeNull();
    ports.pulls.set("env_1", { url: "https://github.com/acme/calc/pull/7", title: "Retry turns", state: "merged" });
    expect(await engine.checkPullRequests()).toBe(1);
    // Read once: merged is not news twice.
    expect(await engine.checkPullRequests()).toBe(0);
  });

  it("a streak offers after enough turns with changes, when turned on", async () => {
    const { runTurn, addFile } = setup({ triggerStreak: true, triggerNewFiles: false, streakTurns: 3 });
    expect(await runTurn(() => addFile("a.ts"))).toBeNull();
    expect(await runTurn(() => addFile("b.ts"))).toBeNull();
    expect(await runTurn(() => addFile("c.ts"))).toMatchObject({ trigger: "streak", topic: '"Add retries"' });
  });

  describe("an offer nobody answers counts toward no limit, shown or not", () => {
    it("not the daily limit, the gap, the snooze or the back-off", async () => {
      const { runTurn, commit, addFile, engine, ports, store } = setup({ offersPerDay: 1, hoursBetweenOffers: 24 });
      // Ten offers in ten threads, every one shown, none answered; each expires with its thread's next turn.
      for (let i = 0; i < 10; i += 1) {
        const id = `thr_${i}`;
        ports.threads.set(id, thread({ id }));
        const offer = await runTurn(() => commit(`c${i}`), id);
        expect(offer).not.toBeNull();
        expect(engine.claim(offer!.id)).toBe(true);
        expect(await runTurn(() => {}, id)).toBeNull();
        expect(store.offer(offer!.id)?.status).toBe("expired");
      }
      expect(store.global(ports.now())).toEqual({ answeredAt: [], consecutiveLaters: 0, backoffUntil: null });
      // A one-a-day cap with a 24 h gap still lets the next one through, and new files still count
      // (a back-off would keep only commits), at once and in a thread that just had one (no snooze).
      expect(await runTurn(() => addFile("src/fresh.ts"))).toMatchObject({ trigger: "new-files" });
      expect(await runTurn(() => addFile("src/again.ts"))).toMatchObject({ trigger: "new-files" });
      expect(store.thread(WORK)).toMatchObject({ snoozeUntil: null, snoozeUntilTurn: null });
    });

    it("an answer is what counts: one answer fills a one-a-day cap", async () => {
      const { runTurn, commit, engine, ports } = setup({ offersPerDay: 1, hoursBetweenOffers: 0 });
      ports.threads.set("thr_b", thread({ id: "thr_b" }));
      const offer = await runTurn(() => commit("A"));
      // Made before the answer, so it was allowed; it may not show once the answer fills the cap.
      const queued = await runTurn(() => commit("B"), "thr_b");
      await engine.answer(offer!.id, "not-thread");
      expect(engine.visibleOffer("thr_b")).toBeNull();
      expect(engine.claim(queued!.id)).toBe(false);
      expect(await runTurn(() => commit("C"), "thr_b")).toBeNull();
    });

    it("not the streak's count: it restarts on an answer only", async () => {
      const { runTurn, addFile, engine, store } = setup({ triggerStreak: true, triggerNewFiles: false, streakTurns: 2, hoursBetweenOffers: 0, offersPerDay: 20 });
      expect(await runTurn(() => addFile("a.ts"))).toBeNull();
      const first = await runTurn(() => addFile("b.ts"));
      expect(first).toMatchObject({ trigger: "streak" });
      expect(engine.claim(first!.id)).toBe(true);
      // Unanswered: the next changed turn still has its streak.
      const second = await runTurn(() => addFile("c.ts"));
      expect(second).toMatchObject({ trigger: "streak" });
      expect(store.thread(WORK).changedTurnsSinceOffer).toBe(3);
      await engine.answer(second!.id, "start");
      expect(store.thread(WORK).changedTurnsSinceOffer).toBe(0);
    });

    it("not sessions per thread: only finished sessions count there", async () => {
      const { runTurn, commit, engine, ports } = setup({ sessionsPerThread: 1, hoursBetweenOffers: 0, offersPerDay: 20 });
      for (let i = 0; i < 3; i += 1) {
        const offer = await runTurn(() => commit(`c${i}`));
        expect(offer).not.toBeNull();
        expect(engine.claim(offer!.id)).toBe(true);
        ports.advance(MINUTE);
      }
    });
  });

  it("does nothing when offers are off, beyond counting the turn", async () => {
    const { runTurn, commit, store } = setup({ offersEnabled: false });
    expect(await runTurn(() => commit("A"))).toBeNull();
    expect(store.thread(WORK).completedTurns).toBe(1);
  });
});
