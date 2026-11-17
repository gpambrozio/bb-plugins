import { describe, expect, it } from "vitest";

import { DEFAULT_CHOICES, type RunRecord } from "../shared/contract-types";
import { DEFAULT_THRESHOLDS } from "../shared/gate";
import type { Changes, Prepared, ProjectStatus } from "../shared/types";
import type { KvLike } from "./history";
import { mapWorktreeFolders } from "./projects";
import { renderPrompt } from "./prompt";
import { createDreamService, MAX_DREAM_MS, type DreamConfig, type DreamPorts, type ThreadState } from "./service";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function memoryKv(): KvLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key),
    list: async (prefix = "") => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}

const NO_CHANGES: Changes = { added: [], changed: [], deleted: [] };

interface FakeProject {
  id: string;
  lastDreamAt: number | null;
  due: boolean;
  /** How long its dream thread runs. */
  takesMs: number;
  changes: Changes;
  thread?: ThreadState["kind"];
  refuse?: string;
}

function setup(options: { projects: FakeProject[]; start: Date; config?: Partial<DreamConfig> }) {
  let now = options.start.getTime();
  const kv = memoryKv();
  const log: string[] = [];
  const order: string[] = [];
  const stopped: string[] = [];
  const archived: string[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const finishes: Array<{ runId: string; ok: boolean }> = [];
  const threads = new Map<string, { project: FakeProject; spawnedAt: number; stopped: boolean }>();
  const runs = new Map<string, FakeProject>();
  const config: DreamConfig = {
    scheduleEnabled: true,
    windowStart: "01:00",
    windowEnd: "03:00",
    thresholds: DEFAULT_THRESHOLDS,
    backupsToKeep: 20,
    notify: true,
    choices: DEFAULT_CHOICES,
    ...options.config,
  };

  const status = (project: FakeProject): ProjectStatus => ({
    projectId: project.id,
    name: project.id,
    checkout: `/repos/${project.id}`,
    enabled: true,
    memory: { dir: `/mem/${project.id}`, source: "default", configured: null, defaultDir: `/mem/${project.id}`, autoMemoryEnabled: true, warnings: [], files: 3, indexLines: 3, indexBytes: 90 },
    gate: { due: project.due, code: project.due ? "due" : "too-soon", reason: "", lastDreamAt: project.lastDreamAt, baselineAt: null, sessionsSince: 6, daysSince: 3 },
    folders: 1,
    sessions: 6,
    inPlace: true,
    pendingProposal: null,
    lastBackup: null,
  });

  const ports: DreamPorts = {
    now: () => now,
    sleep: async (ms, signal) => {
      if (!signal.aborted) now += ms;
    },
    log: { info: (message) => log.push(message), warn: (message) => log.push(message) },
    config: async () => config,
    saveChoices: async () => undefined,
    primaryHostId: async () => "host_1",
    hosts: async () => [{ id: "host_1", name: "Mac", connected: true }],
    projects: async () => options.projects.map((project) => ({ id: project.id, name: project.id, sources: [{ hostId: "host_1", path: `/repos/${project.id}` }] })),
    threadProject: async () => null,
    host: {
      scan: async () => ({ worktreeFolders: [] }),
      status: async (_hostId, input) => ({ projects: input.projects.map((input) => status(options.projects.find((project) => project.id === input.projectId) as FakeProject)) }),
      prepare: async (_hostId, input): Promise<Prepared> => {
        const project = options.projects.find((candidate) => candidate.id === input.project.projectId) as FakeProject;
        if (project.refuse) return { ok: false, code: "locked", reason: project.refuse };
        runs.set(input.runId, project);
        return {
          ok: true,
          mode: "dream",
          workspace: `/ws/${project.id}`,
          targetDir: `/mem/${project.id}`,
          memoryDir: `/mem/${project.id}`,
          checkout: `/repos/${project.id}`,
          transcriptFolders: [],
          sessions: [],
          sessionCount: 6,
          instructionFiles: [],
          backup: "20261117T010000000Z",
          proposal: null,
        };
      },
      finish: async (_hostId, input) => {
        finishes.push({ runId: input.runId, ok: input.ok });
        const project = runs.get(input.runId) as FakeProject;
        if (input.ok) {
          project.due = false;
          project.lastDreamAt = now;
        }
        return { mode: "dream", changes: input.ok ? project.changes : NO_CHANGES, backup: null, proposal: null, proposalDir: null };
      },
      apply: async () => ({ stamp: "", changes: NO_CHANGES, backup: "" }),
      discard: async () => ({ stamp: "" }),
      restore: async () => ({ stamp: "", changes: NO_CHANGES, backup: "" }),
      backups: async () => ({ backups: [], proposals: [] }),
      activeRuns: async () => ({ runs: [] }),
    },
    threads: {
      spawn: async (request) => {
        const project = options.projects.find((candidate) => candidate.id === request.projectId) as FakeProject;
        order.push(project.id);
        const id = `thr_${project.id}${order.length}`;
        threads.set(id, { project, spawnedAt: now, stopped: false });
        return id;
      },
      state: async (threadId) => {
        const thread = threads.get(threadId);
        if (!thread) return { kind: "gone" };
        if (thread.project.thread === "asking") return { kind: "asking" };
        if (thread.project.thread === "failed") return { kind: "failed", error: "boom" };
        return now - thread.spawnedAt >= thread.project.takesMs ? { kind: "finished" } : { kind: "running" };
      },
      output: async (threadId) => `Summary of ${threadId}`,
      stop: async (threadId) => void stopped.push(threadId),
      archive: async (threadId) => void archived.push(threadId),
    },
    kv,
    notify: async (title, body) => void notifications.push({ title, body }),
    publish: () => undefined,
  };
  const service = createDreamService(ports);
  return { service, ports, kv, order, stopped, archived, notifications, finishes, log, now: () => now, advance: (ms: number) => (now += ms) };
}

const at = (hours: number, minutes = 0) => new Date(2026, 10, 17, hours, minutes);
const project = (id: string, lastDreamAt: number | null, takesMs = 20 * MINUTE, changes: Changes = { added: ["a.md"], changed: ["b.md"], deleted: [] }): FakeProject => ({
  id,
  lastDreamAt,
  due: true,
  takesMs,
  changes,
});

describe("the nightly sweep", () => {
  it("dreams the most overdue project first, one at a time, and starts none after the window closes", async () => {
    const base = at(1).getTime();
    const { service, order, stopped, archived } = setup({
      start: at(1),
      projects: [project("recent", base - 4 * DAY, 40 * MINUTE), project("old", base - 9 * DAY, 40 * MINUTE), project("never", null, 40 * MINUTE)],
      config: { windowEnd: "02:00" },
    });
    const dreams = await service.sweep(new AbortController().signal);
    // never: 01:00–01:40, old: 01:40–02:20; recent would start after the window closed at 02:00.
    expect(order).toEqual(["never", "old"]);
    expect(dreams).toBe(2);
    expect(stopped).toEqual(["thr_never1", "thr_old2"]);
    expect(archived).toEqual(["thr_never1", "thr_old2"]);
  });

  it("goes on until every due project has dreamed", async () => {
    const { service, order } = setup({ start: at(1), projects: [project("a", 1), project("b", 2), project("c", 3)] });
    await service.sweep(new AbortController().signal);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does nothing outside the window, or with the schedule off", async () => {
    const outside = setup({ start: at(12), projects: [project("a", null)] });
    expect(await outside.service.sweep(new AbortController().signal)).toBe(0);
    expect(outside.order).toEqual([]);
    const off = setup({ start: at(1), projects: [project("a", null)], config: { scheduleEnabled: false } });
    expect(await off.service.sweep(new AbortController().signal)).toBe(0);
    expect(off.order).toEqual([]);
  });

  it("tries a failing project once per window instead of looping on it", async () => {
    const failing = { ...project("bad", null), thread: "failed" as const };
    const { service, order, finishes } = setup({ start: at(1), projects: [failing, project("good", 5)] });
    await service.sweep(new AbortController().signal);
    expect(order).toEqual(["bad", "good"]);
    expect(finishes.map((finish) => finish.ok)).toEqual([false, true]);
  });

  it("skips a project the host refuses and goes on to the next", async () => {
    const refused = { ...project("locked", null), refuse: "Another dream holds its memory lock." };
    const { service, order } = setup({ start: at(1), projects: [refused, project("next", 5)] });
    await service.sweep(new AbortController().signal);
    expect(order).toEqual(["next"]);
  });
});

describe("a dream", () => {
  it("notifies once when it changed files, and stays silent when it changed none", async () => {
    const { service, notifications } = setup({ start: at(1), projects: [project("busy", 1), project("tight", 2, 20 * MINUTE, NO_CHANGES)] });
    await service.sweep(new AbortController().signal);
    expect(notifications).toEqual([{ title: "Dream: busy", body: "Updated 1, added 1 memory files." }]);
    const runs = await service.history.list();
    expect(runs.map((run: RunRecord) => [run.projectName, run.outcome, run.summary])).toEqual([
      ["tight", "unchanged", "Summary of thr_tight2"],
      ["busy", "changed", "Summary of thr_busy1"],
    ]);
  });

  it("stops and fails a dream that asks for anything, and one that overruns", async () => {
    const asking = { ...project("asks", null), thread: "asking" as const };
    const first = setup({ start: at(1), projects: [asking] });
    await first.service.sweep(new AbortController().signal);
    expect(first.stopped).toEqual(["thr_asks1"]);
    expect((await first.service.history.list())[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining("asked") });

    const slow = setup({ start: at(1), projects: [project("slow", null, MAX_DREAM_MS + 10 * MINUTE)] });
    await slow.service.sweep(new AbortController().signal);
    expect(slow.finishes).toEqual([expect.objectContaining({ ok: false })]);
    expect(slow.archived).toEqual(["thr_slow1"]);
  });

  it("runs one dream at a time when started by hand", async () => {
    const { service } = setup({ start: at(12), projects: [project("a", null, 60 * MINUTE), project("b", null)] });
    const { done } = await service.begin("a", { mode: null, manual: true, trigger: "manual" });
    await expect(service.begin("b", { mode: null, manual: true, trigger: "manual" })).rejects.toThrow(/already running for a/);
    await done;
    await expect(service.begin("b", { mode: null, manual: true, trigger: "manual" })).resolves.toBeDefined();
  });

  it("lets only one of two simultaneous starts through", async () => {
    const { service, order } = setup({ start: at(12), projects: [project("a", null), project("b", null)] });
    const results = await Promise.allSettled([
      service.begin("a", { mode: null, manual: true, trigger: "manual" }),
      service.begin("b", { mode: null, manual: true, trigger: "manual" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(order).toEqual(["a"]);
  });

  it("is stopped by hand as a failure, so its lock rolls back", async () => {
    const { service, finishes, stopped } = setup({ start: at(12), projects: [project("a", null, 60 * MINUTE)] });
    const { done } = await service.begin("a", { mode: null, manual: true, trigger: "manual" });
    expect(await service.stopActive()).toBe(true);
    const ended = await done;
    expect(ended).toMatchObject({ outcome: "failed", error: "Stopped by hand." });
    expect(finishes).toEqual([expect.objectContaining({ ok: false })]);
    expect(stopped).toEqual(["thr_a1"]);
    expect(await service.stopActive()).toBe(false);
  });

  it("is picked up and finished by the next copy of the plugin after a reload", async () => {
    const first = setup({ start: at(12), projects: [project("a", null, 30 * MINUTE)] });
    const { record } = await first.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    first.service.dispose();
    const active = await first.kv.get<RunRecord>("active-run");
    expect(active?.threadId).toBe(record.threadId);

    // The new copy shares the stores (kv, host, threads) with the old one.
    const second = createDreamService(first.ports);
    await second.recover();
    expect(await first.kv.get("active-run")).toBeUndefined();
    expect((await second.history.list())[0]).toMatchObject({ outcome: "changed", threadId: record.threadId });
  });
});

describe("worktree folders", () => {
  const checkouts = [
    { projectId: "proj_app", name: "app", checkout: "/repos/app" },
    { projectId: "proj_web", name: "web", checkout: "/repos/web" },
    { projectId: "proj_web2", name: "web (laptop copy)", checkout: "/other/web" },
  ];

  it("maps a folder to its thread's project, and falls back to the repository name when the thread is gone", async () => {
    const lookups: string[] = [];
    const lookup = async (threadId: string) => {
      lookups.push(threadId);
      return threadId === "thr_live" ? "proj_app" : threadId === "thr_flaky" ? undefined : null;
    };
    const folders = [
      { name: "f-live", threadId: "thr_live", repoSlug: "app" },
      { name: "f-gone", threadId: "thr_gone", repoSlug: "app" },
      { name: "f-ambiguous", threadId: "thr_gone2", repoSlug: "web" },
      { name: "f-cached", threadId: "thr_cached", repoSlug: "zzz" },
      { name: "f-flaky", threadId: "thr_flaky", repoSlug: "app" },
    ];
    const mapping = await mapWorktreeFolders(folders, checkouts, { thr_cached: "proj_web" }, lookup);
    expect(Object.fromEntries(mapping.byProject)).toEqual({ proj_app: ["f-live", "f-gone"], proj_web: ["f-cached"] });
    expect(mapping.learned).toEqual({ thr_live: "proj_app", thr_gone: null, thr_gone2: null });
    expect(lookups).not.toContain("thr_cached");
  });

  it("ignores a thread whose project has no checkout on the dream machine", async () => {
    const mapping = await mapWorktreeFolders([{ name: "f", threadId: "thr_x", repoSlug: "app" }], checkouts, {}, async () => "proj_elsewhere");
    expect(mapping.byProject.size).toBe(0);
  });
});

describe("the prompt", () => {
  it("fills in the run's facts and keeps native's phases, reconcile rules and tool limits", () => {
    const prompt = renderPrompt({
      targetDir: "/mem/app",
      checkout: "/repos/app",
      transcriptFolders: ["/home/.claude/projects/-repos-app"],
      sessions: [{ path: "/home/.claude/projects/-repos-app/s1.jsonl", date: "2026-11-16 22:10", title: "Fix the build", size: 2048 }],
      sessionCount: 7,
      instructionFiles: ["/repos/app/CLAUDE.md"],
    });
    expect(prompt).not.toMatch(/\{\{|^---/);
    expect(prompt.startsWith("# Dream: Memory Consolidation")).toBe(true);
    expect(prompt).toContain("Memory directory: `/mem/app`");
    for (const heading of ["## Phase 1 — Orient", "## Phase 2 — Gather recent signal", "## Phase 3 — Consolidate", "## Phase 4 — Prune and index", "### Reconcile memories against CLAUDE.md"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("under 200 lines AND under ~25KB");
    expect(prompt).toContain("Never edit CLAUDE.md or AGENTS.md");
    expect(prompt).toContain("Sessions since last consolidation (7)");
    expect(prompt).toContain("- 2026-11-16 22:10 · Fix the build · 2 KB · /home/.claude/projects/-repos-app/s1.jsonl");
    expect(prompt).toContain("… and 6 older sessions");
    expect(prompt).toContain("`/repos/app/CLAUDE.md`");
  });
});
