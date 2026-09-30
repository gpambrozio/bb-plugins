import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREW_METADATA, type BacklogItem, type CrewSummary, type ThreadStatus, type WatchSummary } from "../shared/types";
import { parseBacklog } from "./backlog";
import { ReportCache, backlogColumn, buildCards, crewColumn, loadFleet, type FleetDeps } from "./fleet";
import type { FirstmateSettings } from "./settings";
import { fakeLog, fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

function crew(overrides: Partial<CrewSummary> = {}): CrewSummary {
  return {
    threadId: "thr_1",
    title: "Fix login",
    status: "idle",
    pendingInteractions: 0,
    projectId: "prj_web",
    environmentId: "env_1",
    updatedAt: 1_000,
    task: "fix-login",
    kind: null,
    project: null,
    ...overrides,
  };
}

describe("crewColumn", () => {
  const done = { state: "done" as const, text: "PR" };

  it("lets what bb knows win while the thread is busy or stuck", () => {
    expect(crewColumn(crew({ pendingInteractions: 1, status: "active" }), done)).toBe("blocked");
    expect(crewColumn(crew({ pendingInteractions: 2, status: "idle" }), null)).toBe("blocked");
    expect(crewColumn(crew({ status: "error" }), done)).toBe("failed");
  });

  it.each<[ThreadStatus, string]>([
    ["active", "working"],
    ["starting", "working"],
    ["pending", "working"],
    ["stopping", "working"],
  ])("files a %s thread as %s whatever its last status line said", (status, column) => {
    expect(crewColumn(crew({ status }), done)).toBe(column);
    expect(crewColumn(crew({ status }), { state: "blocked", text: "" })).toBe(column);
    expect(crewColumn(crew({ status }), null)).toBe(column);
  });

  it("files an idle thread by its status line", () => {
    expect(crewColumn(crew(), { state: "done", text: "" })).toBe("idle");
    expect(crewColumn(crew(), { state: "resolved", text: "" })).toBe("idle");
    expect(crewColumn(crew(), { state: "blocked", text: "" })).toBe("blocked");
    expect(crewColumn(crew(), { state: "needs-decision", text: "" })).toBe("blocked");
    expect(crewColumn(crew(), { state: "paused", text: "" })).toBe("parked");
    expect(crewColumn(crew(), { state: "failed", text: "" })).toBe("failed");
    expect(crewColumn(crew(), { state: "working", text: "" })).toBe("idle");
    expect(crewColumn(crew(), null)).toBe("idle");
  });
});

describe("backlogColumn", () => {
  const item = (overrides: Partial<BacklogItem>): BacklogItem => ({
    section: "queued",
    id: "x",
    title: "X",
    project: null,
    kind: null,
    mode: null,
    threadId: null,
    hold: null,
    blockedBy: null,
    since: null,
    url: null,
    reportPath: null,
    outcome: null,
    ...overrides,
  });

  it("puts a captain's hold with the blocked work and everything else where its section says", () => {
    expect(backlogColumn(item({ kind: "captain" }))).toBe("blocked");
    expect(backlogColumn(item({ hold: "which?" }))).toBe("blocked");
    expect(backlogColumn(item({}))).toBe("queued");
    expect(backlogColumn(item({ section: "done" }))).toBe("done");
    expect(backlogColumn(item({ section: "in-flight" }))).toBe("idle");
  });
});

describe("buildCards", () => {
  const backlog = parseBacklog(`## In flight
- [ ] fix-login - Fix the login (project: web) (kind: ship)
- [ ] by-id - Found by thread (thread: thr_2)
- [ ] orphan - Nobody on it
## Queued
- [ ] next - Next thing
## Done
- [x] fix-login - An older task with the same id https://github.com/o/r/pull/1 (merged 2026-09-01)
`);

  it("joins a crewmate to its item by metadata task or by backlog (thread: …), and keeps the rest", () => {
    const cards = buildCards(backlog, [
      { summary: crew(), report: { state: "done", text: "PR https://github.com/o/r/pull/42" } },
      { summary: crew({ threadId: "thr_2", task: null }), report: null },
      { summary: crew({ threadId: "thr_3", title: "Stray", task: null }), report: null },
    ]);
    const byKey = new Map(cards.map((card) => [card.key, card]));

    expect(byKey.get("crew:thr_1")).toMatchObject({
      column: "idle",
      taskId: "fix-login",
      title: "Fix the login",
      project: "web",
      kind: "ship",
      url: "https://github.com/o/r/pull/42",
    });
    expect(byKey.get("crew:thr_2")).toMatchObject({ taskId: "by-id", title: "Found by thread" });
    expect(byKey.get("crew:thr_3")).toMatchObject({ taskId: null, title: "Stray", backlog: null });
    expect(cards.filter((card) => card.crew === null).map((card) => [card.taskId, card.column])).toEqual([
      ["orphan", "idle"],
      ["next", "queued"],
      ["fix-login", "done"],
    ]);
  });

  it("gives a backlog item with no crew its own card in the backlog's column", () => {
    const cards = buildCards(backlog, []);
    expect(cards.map((card) => [card.taskId, card.column, card.crew, card.report])).toEqual([
      ["fix-login", "idle", null, null],
      ["by-id", "idle", null, null],
      ["orphan", "idle", null, null],
      ["next", "queued", null, null],
      ["fix-login", "done", null, null],
    ]);
  });

  it("makes a child with no firstmate metadata a card, filed by its status", () => {
    const [card] = buildCards([], [{ summary: crew({ task: null, kind: null, project: null, status: "active", title: null }), report: null }]);
    expect(card).toMatchObject({
      column: "working",
      taskId: null,
      kind: null,
      project: null,
      backlog: null,
      title: "Untitled crewmate",
    });
  });

  it("prefers the thread's own project and kind over the backlog's, and lists the most recently moved crewmate first", () => {
    const cards = buildCards(backlog, [
      { summary: crew({ threadId: "thr_old", task: "orphan", updatedAt: 1 }), report: null },
      { summary: crew({ threadId: "thr_new", project: "api", kind: "fix", updatedAt: 2 }), report: null },
    ]);
    expect(cards.slice(0, 2).map((card) => card.key)).toEqual(["crew:thr_new", "crew:thr_old"]);
    expect(cards[0]).toMatchObject({ project: "api", kind: "fix" });
  });
});

describe("ReportCache", () => {
  it("fetches lastText once per updatedAt and never mid-turn", async () => {
    const threads = fakeThreads();
    const thread = threads.add({ id: "thr_1" });
    threads.setText(thread.id, "All green.\ndone: PR https://x/1");
    const cache = new ReportCache(threads);

    expect(await cache.report(crew({ status: "active" }))).toBeNull();
    expect(threads.callsTo("lastText")).toEqual([]);

    const first = await cache.report(crew({ updatedAt: 5 }));
    expect(first).toEqual({ state: "done", text: "PR https://x/1" });
    expect(await cache.report(crew({ updatedAt: 5 }))).toEqual(first);
    expect(threads.callsTo("lastText")).toHaveLength(1);

    // A turn in flight keeps the previous line on the card.
    expect(await cache.report(crew({ updatedAt: 6, status: "active" }))).toEqual(first);
    expect(threads.callsTo("lastText")).toHaveLength(1);

    threads.setText(thread.id, "blocked: need a key");
    expect(await cache.report(crew({ updatedAt: 7, status: "error" }))).toEqual({ state: "blocked", text: "need a key" });
    expect(threads.callsTo("lastText")).toHaveLength(2);
  });

  it("remember() spares the fetch", async () => {
    const threads = fakeThreads();
    threads.add({ id: "thr_1" });
    const cache = new ReportCache(threads);
    cache.remember("thr_1", 9, "done: shipped");
    expect(await cache.report(crew({ updatedAt: 9 }))).toEqual({ state: "done", text: "shipped" });
    expect(threads.callsTo("lastText")).toEqual([]);

    cache.remember("thr_1", 10, null);
    expect(await cache.report(crew({ updatedAt: 10 }))).toBeNull();
    expect(threads.callsTo("lastText")).toEqual([]);
  });

  it("forgets crewmates no longer aboard", async () => {
    const threads = fakeThreads();
    threads.add({ id: "thr_1" });
    threads.setText("thr_1", "done: x");
    const cache = new ReportCache(threads);
    await cache.report(crew({ updatedAt: 1 }));
    cache.retain(new Set());
    await cache.report(crew({ updatedAt: 1 }));
    expect(threads.callsTo("lastText")).toHaveLength(2);
  });
});

describe("loadFleet", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup(files: Record<string, string> = {}, watches: WatchSummary[] = []) {
    const home = await mkdtemp(join(tmpdir(), "firstmate-fleet-"));
    tempDirs.push(home);
    await mkdir(join(home, "data"), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(home, name), text, "utf8");
    const threads = fakeThreads();
    const store = memoryStore();
    const settings: FirstmateSettings = {
      homeDirectory: home,
      crewProvider: "",
      crewModel: "",
      crewReasoning: "default",
      refreshSeconds: 10,
    };
    const log = fakeLog();
    const deps: FleetDeps = {
      threads,
      projects: fakeProjects(),
      store,
      settings: async () => settings,
      reports: new ReportCache(threads),
      watches: async () => watches,
      log,
    };
    return { home, threads, store, deps, log };
  }

  it("with no stored first mate, draws the backlog alone", async () => {
    const { deps, threads, home } = await setup({ "data/backlog.md": "## Queued\n- [ ] next - Next thing\n" });
    threads.add({ id: "thr_stray", parentThreadId: "thr_other" });
    const fleet = await loadFleet(deps);
    expect(fleet).toMatchObject({ home, mate: null, mateMissing: false });
    expect(fleet.cards.map((card) => [card.taskId, card.column])).toEqual([["next", "queued"]]);
    expect(threads.callsTo("children")).toEqual([]);
  });

  it("with a stored id that no longer resolves, says the first mate is missing", async () => {
    const { deps, store, threads } = await setup();
    await store.setMateThreadId("thr_gone");
    expect(await loadFleet(deps)).toMatchObject({ mate: null, mateMissing: true, cards: [] });

    const archived = threads.add({ id: "thr_archived" });
    threads.archiveNow(archived.id);
    await store.setMateThreadId(archived.id);
    expect((await loadFleet(deps)).mateMissing).toBe(true);
  });

  it("joins the mate's children to the backlog, with their metadata, pending interactions and status line", async () => {
    const { deps, store, threads } = await setup({
      "data/backlog.md": "## In flight\n- [ ] fix-login - Fix the login (project: web)\n## Queued\n- [ ] next - Next\n",
      "data/suggestions.md": "- Bearings :: ahoy\n",
    });
    const mate = threads.add({ id: "thr_mate", title: "First mate", status: "active" });
    await store.setMateThreadId(mate.id);
    threads.add({ id: "thr_a", title: "Login", parentThreadId: mate.id, status: "idle", environmentId: "env_a" });
    threads.setMetadata("thr_a", { [CREW_METADATA.role]: CREW_METADATA.crewRole, [CREW_METADATA.task]: "fix-login", [CREW_METADATA.kind]: "ship" });
    threads.setText("thr_a", "Landed.\ndone: PR https://github.com/o/r/pull/9");
    threads.add({ id: "thr_b", title: "Bare", parentThreadId: mate.id, status: "active" });
    threads.setPendingInteractions("thr_b", 1);
    threads.add({ id: "thr_elsewhere", title: "Not mine", parentThreadId: "thr_other" });

    const fleet = await loadFleet(deps);
    expect(fleet.mate).toEqual({ threadId: "thr_mate", status: "active", title: "First mate" });
    expect(fleet.mateMissing).toBe(false);
    const byKey = new Map(fleet.cards.map((card) => [card.key, card]));
    expect([...byKey.keys()].some((key) => key.includes("thr_elsewhere"))).toBe(false);
    expect(byKey.get("crew:thr_a")).toMatchObject({
      column: "idle",
      taskId: "fix-login",
      title: "Fix the login",
      project: "web",
      kind: "ship",
      url: "https://github.com/o/r/pull/9",
      crew: { threadId: "thr_a", task: "fix-login", kind: "ship", environmentId: "env_a", pendingInteractions: 0 },
    });
    expect(byKey.get("crew:thr_b")).toMatchObject({ column: "blocked", taskId: null, crew: { task: null, pendingInteractions: 1 } });
    expect(fleet.cards.find((card) => card.taskId === "next")).toMatchObject({ column: "queued", crew: null });
  });

  it("shows a card without a status line when reading it fails, and says why", async () => {
    const { deps, store, threads, log } = await setup();
    const mate = threads.add({ id: "thr_mate" });
    await store.setMateThreadId(mate.id);
    threads.add({ id: "thr_a", parentThreadId: mate.id });
    threads.failNext("lastText", new Error("timeline unavailable"));

    const fleet = await loadFleet(deps);
    expect(fleet.cards).toHaveLength(1);
    expect(fleet.cards[0]).toMatchObject({ column: "idle", report: null });
    expect(log.errors).toEqual([expect.stringMatching(/status line of thr_a.*timeline unavailable/)]);
  });

  it("with backlog.md and suggestions.md missing, draws an empty board without throwing", async () => {
    const { deps, home } = await setup();
    expect(await loadFleet(deps)).toMatchObject({ home, homeReady: false, cards: [], suggestions: [], watches: [] });
  });

  it("with backlog.md and suggestions.md empty, draws an empty board without throwing", async () => {
    const { deps } = await setup({ "data/backlog.md": "", "data/suggestions.md": "" });
    expect(await loadFleet(deps)).toMatchObject({ cards: [], suggestions: [] });
  });

  it("loads the board from the crew alone when the backlog cannot be read, and says why", async () => {
    const { deps, store, threads, home, log } = await setup();
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    await mkdir(join(home, "data", "backlog.md"));
    const mate = threads.add({ id: "thr_mate" });
    await store.setMateThreadId(mate.id);
    threads.add({ id: "thr_a", parentThreadId: mate.id });

    const fleet = await loadFleet(deps);
    expect(fleet.cards.map((card) => card.key)).toEqual(["crew:thr_a"]);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toMatch(/backlog/);
    expect(log.errors[0]).toContain(home);
    expect(log.errors[0]).toMatch(/EISDIR/);
  });

  it("falls back to nothing for a suggestions file that cannot be read, and logs it", async () => {
    const { deps, home, log } = await setup({ "data/backlog.md": "## Queued\n- [ ] next - Next\n" });
    await mkdir(join(home, "data", "suggestions.md"));

    const fleet = await loadFleet(deps);
    expect(fleet.suggestions).toEqual([]);
    expect(fleet.cards).toHaveLength(1);
    expect(log.errors).toEqual([expect.stringMatching(/suggestions/)]);
    expect(log.errors[0]).toContain(home);
  });

  it("falls back to an untouched charter when the charter cannot be read, and logs it", async () => {
    const { deps, home, log } = await setup();
    await mkdir(join(home, "data", "charter.md"));

    const fleet = await loadFleet(deps);
    expect(fleet.charter).toMatchObject({ edited: false, outdated: false });
    expect(log.errors).toEqual([expect.stringMatching(/charter/)]);
    expect(log.errors[0]).toContain(home);
  });

  it("shows no watches when reading them fails, and logs it", async () => {
    const { deps, home, log } = await setup({ "data/backlog.md": "## Queued\n- [ ] next - Next\n" });
    const fleet = await loadFleet({ ...deps, watches: async () => Promise.reject(new Error("watch state corrupt")) });
    expect(fleet.watches).toEqual([]);
    expect(fleet.cards).toHaveLength(1);
    expect(log.errors).toEqual([expect.stringMatching(/watches.*watch state corrupt/)]);
    expect(log.errors[0]).toContain(home);
  });

  it("keeps a child on the board when reading its metadata or pending interactions fails", async () => {
    const { deps, store, threads, log } = await setup();
    const mate = threads.add({ id: "thr_mate" });
    await store.setMateThreadId(mate.id);
    threads.add({ id: "thr_a", title: "A", parentThreadId: mate.id });
    threads.add({ id: "thr_b", title: "B", parentThreadId: mate.id });
    threads.setMetadata("thr_a", { [CREW_METADATA.task]: "a-task" });
    threads.failNext("metadata", new Error("metadata unavailable"));

    const fleet = await loadFleet(deps);
    expect(fleet.cards).toHaveLength(2);
    expect(fleet.cards.every((card) => card.crew !== null)).toBe(true);
    expect(log.errors).toEqual([expect.stringMatching(/metadata of thr_.*metadata unavailable/)]);

    threads.failNext("pendingInteractions", new Error("interactions unavailable"));
    const again = await loadFleet(deps);
    expect(again.cards).toHaveLength(2);
    expect(again.cards.every((card) => card.crew?.pendingInteractions === 0)).toBe(true);
  });

  it("does not throw on a half-written backlog.md or suggestions.md", async () => {
    const half = await setup({ "data/backlog.md": "## In fli", "data/suggestions.md": "- [ " });
    expect(await loadFleet(half.deps)).toMatchObject({ cards: [] });

    const partial = await setup({ "data/backlog.md": "## In flight\n- [ ] ok - Fine\n- [ ", "data/suggestions.md": "- Good :: prompt\n- [ " });
    const fleet = await loadFleet(partial.deps);
    expect(fleet.cards.map((card) => card.taskId)).toEqual(["ok"]);
    expect(fleet.suggestions).toEqual([{ label: "Good", prompt: "prompt" }]);
  });

  it("carries the suggestions, the watches and the charter state", async () => {
    const watch: WatchSummary = {
      name: "pr-watch",
      schedule: "*/5 * * * *",
      enabled: true,
      invalid: null,
      running: false,
      lastRunAt: null,
      lastResult: "never",
      lastOutput: null,
      lastOutputAt: null,
      lastError: null,
      builtIn: true,
      outdated: false,
    };
    const { deps } = await setup({ "data/suggestions.md": "- Go :: do the thing\n" }, [watch]);
    const fleet = await loadFleet(deps);
    expect(fleet.watches).toEqual([watch]);
    expect(fleet.suggestions).toEqual([{ label: "Go", prompt: "do the thing" }]);
    expect(fleet.charter).toMatchObject({ edited: false, outdated: false });
  });
});
