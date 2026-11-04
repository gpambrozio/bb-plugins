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

  it("never offers in a child, a plugin's or a hidden thread", async () => {
    const { ports, runTurn, commit } = setup();
    for (const [id, change] of [
      ["thr_child", { parentThreadId: WORK }],
      ["thr_plugin", { originPluginId: "automations" }],
      ["thr_hidden", { visibility: "hidden" }],
    ] as const) {
      ports.threads.set(id, thread({ id, ...change }));
      expect(await runTurn(() => commit("x"), id)).toBeNull();
    }
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

  it("an offer counts toward the caps only once seen", async () => {
    const { runTurn, commit, engine, store, ports } = setup();
    const offer = await runTurn(() => commit("First"));
    expect(store.global(ports.now()).seenAt).toEqual([]);
    expect(engine.seen(offer!.id)).toBe(true);
    expect(engine.seen(offer!.id)).toBe(false);
    expect(store.global(ports.now()).seenAt).toEqual([ports.now()]);
    // Seen 2 h ago at the latest: a commit an hour later is not offered.
    await engine.answer(offer!.id, "not-thread");
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

  it("does nothing when offers are off, beyond counting the turn", async () => {
    const { runTurn, commit, store } = setup({ offersEnabled: false });
    expect(await runTurn(() => commit("A"))).toBeNull();
    expect(store.thread(WORK).completedTurns).toBe(1);
  });
});
