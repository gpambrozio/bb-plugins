import { describe, expect, it } from "vitest";

import { DEFAULT_CHOICES, type RunRecord } from "../shared/contract-types";
import { DEFAULT_THRESHOLDS } from "../shared/gate";
import type { Changes, Prepared, ProjectStatus } from "../shared/types";
import type { KvLike } from "./history";
import { mapWorktreeFolders } from "./projects";
import { renderPrompt } from "./prompt";
import { blockedByCompanion, createDreamService, MAX_DREAM_MS, START_GRACE_MS, type ActiveState, type DreamConfig, type DreamPorts, type DreamService, type ThreadState } from "./service";

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
  /** How long its dream turn runs. */
  takesMs: number;
  changes: Changes;
  thread?: ThreadState["kind"];
  refuse?: string;
}

/** How a fake bb and dream machine misbehave, switchable during a test. */
interface Faults {
  /** The startup check's verdict; proven by default. */
  canary: { ok: boolean; reason: string };
  stopFails: boolean;
  /** bb keeps saying the thread runs after a stop. */
  neverStops: boolean;
  finishFails: boolean;
  archiveFails: boolean;
  /** Extra time each status scan and each prepare takes. */
  statusMs: number;
  prepareMs: number;
  /** Called while `spawn` is in flight, before it answers. */
  duringSpawn?: () => void;
  /** The errors bb recorded for the canary Write; the companion's block by default. */
  writeErrors: string[];
  /** When set, `finish` waits for this before answering. */
  finishGate?: Promise<void>;
  /** Host runs nobody watches, as `activeRuns` reports them. */
  hostRuns: Array<{ runId: string; projectId: string; startedAt: number }>;
}

const COMPANION_ERROR = "PreToolUse:Write hook error: ['node' 'guard.mjs' --canary-fail 'policy.json']: failed; blocking because onFailure is \"block\"";

const CANARY_MS = MINUTE;

function setup(options: { projects: FakeProject[]; start: Date; config?: Partial<DreamConfig> }) {
  let now = options.start.getTime();
  const kv = memoryKv();
  const log: string[] = [];
  const order: string[] = [];
  const stopped: string[] = [];
  const archived: string[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const finishes: Array<{ runId: string; ok: boolean }> = [];
  const threads = new Map<string, { project: FakeProject; spawnedAt: number; sentAt: number | null; stopped: boolean; archived: boolean }>();
  const runs = new Map<string, FakeProject>();
  const finished = new Set<string>();
  const faults: Faults = {
    canary: { ok: true, reason: "proven" },
    stopFails: false,
    neverStops: false,
    finishFails: false,
    archiveFails: false,
    statusMs: 0,
    prepareMs: 0,
    writeErrors: [COMPANION_ERROR],
    hostRuns: [],
  };
  const canaryChecks: string[] = [];
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
      status: async (_hostId, input) => {
        now += faults.statusMs;
        return { projects: input.projects.map((input) => status(options.projects.find((project) => project.id === input.projectId) as FakeProject)) };
      },
      prepare: async (_hostId, input): Promise<Prepared> => {
        const project = options.projects.find((candidate) => candidate.id === input.project.projectId) as FakeProject;
        if (project.refuse) return { ok: false, code: "locked", reason: project.refuse };
        now += faults.prepareMs;
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
          canary: `/ws/${project.id}/.dream-canary.md`,
        };
      },
      checkCanary: async (_hostId, input) => {
        canaryChecks.push(input.runId);
        return faults.canary;
      },
      finish: async (_hostId, input) => {
        finishes.push({ runId: input.runId, ok: input.ok });
        const gate = faults.finishGate;
        if (gate) await gate;
        if (faults.finishFails) throw new Error("the dream machine is offline");
        const project = runs.get(input.runId);
        if (project === undefined) return { found: false, mode: "dream", changes: NO_CHANGES, backup: null, proposal: null, proposalDir: null, warning: null };
        if (input.ok && !finished.has(input.runId)) {
          project.due = false;
          project.lastDreamAt = now;
        }
        finished.add(input.runId);
        return { found: true, mode: "dream", changes: input.ok ? project.changes : NO_CHANGES, backup: null, proposal: null, proposalDir: null, warning: null };
      },
      apply: async () => ({ stamp: "", changes: NO_CHANGES, backup: "" }),
      discard: async () => ({ stamp: "" }),
      restore: async () => ({ stamp: "", changes: NO_CHANGES, backup: "" }),
      backups: async () => ({ backups: [], proposals: [] }),
      activeRuns: async () => ({ runs: faults.hostRuns }),
    },
    threads: {
      spawn: async (request) => {
        const project = options.projects.find((candidate) => candidate.id === request.projectId) as FakeProject;
        order.push(project.id);
        const id = `thr_${project.id}${order.length}`;
        threads.set(id, { project, spawnedAt: now, sentAt: null, stopped: false, archived: false });
        expect(request.prompt).toContain("Dream startup check");
        expect(request.prompt).not.toContain("# Dream: Memory Consolidation");
        faults.duringSpawn?.();
        return id;
      },
      writeErrors: async () => faults.writeErrors,
      send: async (threadId, text) => {
        sent.push({ threadId, text });
        const thread = threads.get(threadId);
        if (thread) thread.sentAt = now;
      },
      state: async (threadId, turns) => {
        const thread = threads.get(threadId);
        if (!thread) return { kind: "gone" };
        if (turns === 1) return now - thread.spawnedAt >= CANARY_MS ? { kind: "finished" } : { kind: "running" };
        if (thread.project.thread === "asking") return { kind: "asking" };
        if (thread.project.thread === "failed") return { kind: "failed", error: "boom" };
        if (thread.sentAt === null) return { kind: "running" };
        return now - thread.sentAt >= thread.project.takesMs ? { kind: "finished" } : { kind: "running" };
      },
      output: async (threadId) => `Summary of ${threadId}`,
      stop: async (threadId) => {
        if (faults.stopFails) throw new Error("the provider is unreachable");
        stopped.push(threadId);
        const thread = threads.get(threadId);
        if (thread) thread.stopped = true;
      },
      stopped: async (threadId) => !faults.neverStops && (threads.get(threadId)?.stopped ?? true),
      archive: async (threadId) => {
        if (faults.archiveFails) throw new Error("archive failed");
        archived.push(threadId);
        const thread = threads.get(threadId);
        if (thread) thread.archived = true;
      },
      listOpen: async () => [...threads].filter(([, thread]) => !thread.archived).map(([id]) => id),
    },
    kv,
    notify: async (title, body) => void notifications.push({ title, body }),
    publish: () => undefined,
  };
  const service = createDreamService(ports);
  return {
    service,
    ports,
    kv,
    faults,
    canaryChecks,
    order,
    sent,
    stopped,
    archived,
    notifications,
    finishes,
    log,
    threads,
    now: () => now,
    advance: (ms: number) => (now += ms),
    active: () => kv.get<ActiveState>("active-run"),
  };
}

/** Runs `loop` for `ticks` minutes of fake time. */
async function tick(context: ReturnType<typeof setup>, service: DreamService, ticks: number): Promise<void> {
  const controller = new AbortController();
  const end = context.now() + ticks * MINUTE;
  const ports = context.ports;
  const sleep = ports.sleep;
  ports.sleep = async (ms, signal) => {
    await sleep(ms, signal);
    if (context.now() >= end) controller.abort();
  };
  await service.loop(controller.signal);
  ports.sleep = sleep;
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
    // never: 01:00–01:41 (startup check, then dream), old: 01:41–02:22; recent would start after 02:00.
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
    const active = await first.active();
    expect(active?.record.threadId).toBe(record.threadId);

    // The new copy shares the stores (kv, host, threads) with the old one.
    const second = createDreamService(first.ports);
    await second.recover();
    expect(await first.kv.get("active-run")).toBeUndefined();
    expect((await second.history.list())[0]).toMatchObject({ outcome: "changed", threadId: record.threadId });
  });
});

describe("the startup check", () => {
  it("sends the dream prompt only after the guard is proven, as a second turn", async () => {
    const { service, sent } = setup({ start: at(12), projects: [project("a", null)] });
    const { done } = await service.begin("a", { mode: null, manual: true, trigger: "manual" });
    await done;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("# Dream: Memory Consolidation");
  });

  it("never sends the dream prompt when the guard cannot be proven, and fails the run", async () => {
    const context = setup({ start: at(12), projects: [project("a", null)] });
    context.faults.canary = { ok: false, reason: "the guard never saw the check's Write" };
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    const ended = await done;
    expect(context.sent).toEqual([]);
    expect(ended).toMatchObject({ outcome: "failed", error: expect.stringContaining("could not be proven active") });
    expect(context.finishes).toEqual([expect.objectContaining({ ok: false })]);
    expect(context.stopped).toEqual(["thr_a1"]);
  });
});

describe("binding the check to the plugin's own hook", () => {
  it("passes only on the companion hook's onFailure block", () => {
    expect(blockedByCompanion([COMPANION_ERROR])).toBe(true);
    expect(blockedByCompanion(["PreToolUse:Write hook error: [my-policy.sh]: blocked by policy"])).toBe(false);
    expect(blockedByCompanion(["PreToolUse:Write hook error: ['node' 'guard.mjs' --canary-fail 'policy.json']: failed"])).toBe(false);
    expect(blockedByCompanion([])).toBe(false);
  });

  it("fails the run, without asking the host or sending the prompt, when another hook denied the canary", async () => {
    const context = setup({ start: at(12), projects: [project("a", null)] });
    context.faults.writeErrors = ["PreToolUse:Write hook error: [company-hook]: denied by policy"];
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    expect(await done).toMatchObject({ outcome: "failed", error: expect.stringContaining("plugin's own failing hook") });
    expect(context.canaryChecks).toEqual([]);
    expect(context.sent).toEqual([]);
  });
});

describe("orphans not confirmed stopped", () => {
  it("block the host's clean-up and every new start until they are", async () => {
    const context = setup({ start: at(12), projects: [project("a", null)] });
    context.threads.set("thr_lost", { project: project("a", null), spawnedAt: context.now(), sentAt: null, stopped: false, archived: false });
    context.faults.hostRuns = [{ runId: "old-run", projectId: "a", startedAt: context.now() - 5 * 60 * MINUTE }];
    context.faults.stopFails = true;
    context.faults.neverStops = true;
    await tick(context, context.service, 2);
    expect(context.finishes).toEqual([]);
    await expect(context.service.begin("a", { mode: null, manual: true, trigger: "manual" })).rejects.toThrow(/could not be confirmed stopped/);

    context.faults.stopFails = false;
    context.faults.neverStops = false;
    await tick(context, context.service, 1);
    expect(context.finishes).toEqual([{ runId: "old-run", ok: false }]);
    await expect(context.service.begin("a", { mode: null, manual: true, trigger: "manual" })).resolves.toBeDefined();
  });
});

describe("two copies of the plugin at once", () => {
  it("never lets the old copy's late finish erase a newer run's marker", async () => {
    const context = setup({ start: at(12), projects: [project("a", null, 5 * MINUTE), project("b", null, 60 * MINUTE)] });
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    // The old copy's finish is held up in flight...
    let release: () => void = () => undefined;
    context.faults.finishGate = new Promise((resolve) => (release = resolve));
    const old = done;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ...while bb loads the new copy, which finishes the same run and starts the next one.
    context.service.dispose();
    const fresh = createDreamService(context.ports);
    context.faults.finishGate = undefined;
    const recovered = fresh.recover();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await recovered;
    const next = await fresh.begin("b", { mode: null, manual: true, trigger: "manual" });
    expect((await context.active())?.record.runId).toBe(next.record.runId);
    release();
    await old;
    expect((await context.active())?.record.runId).toBe(next.record.runId);
    expect((await context.active())?.phase).toBe("checking");
  });
});

describe("ending a dream safely", () => {
  it("keeps the run, and its lock, while bb cannot confirm the thread stopped", async () => {
    const context = setup({ start: at(12), projects: [project("a", null, 5 * MINUTE)] });
    context.faults.stopFails = true;
    context.faults.neverStops = true;
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    await done;
    expect(context.finishes).toEqual([]);
    expect((await context.active())?.phase).toBe("stopping");
    await expect(context.service.begin("a", { mode: null, manual: true, trigger: "manual" })).rejects.toThrow(/already running/);

    // Ticks retry the stop; nothing is released until it is confirmed.
    await tick(context, context.service, 3);
    expect(context.finishes).toEqual([]);
    context.faults.stopFails = false;
    context.faults.neverStops = false;
    await tick(context, context.service, 2);
    expect(context.finishes).toEqual([expect.objectContaining({ ok: true })]);
    expect(await context.active()).toBeUndefined();
  });

  it("keeps the run until the dream machine acknowledges the finish, then retries it", async () => {
    const context = setup({ start: at(12), projects: [project("a", null, 5 * MINUTE)] });
    context.faults.finishFails = true;
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    await done;
    expect((await context.active())?.phase).toBe("finishing");
    expect(await context.service.history.list()).toEqual([expect.objectContaining({ outcome: "running" })]);
    await tick(context, context.service, 2);
    expect(await context.active()).toBeDefined();
    context.faults.finishFails = false;
    await tick(context, context.service, 2);
    expect(await context.active()).toBeUndefined();
    expect((await context.service.history.list())[0]).toMatchObject({ outcome: "changed" });
    expect(context.notifications).toHaveLength(1);
  });

  it("retries an archive that failed, without holding the lock for it", async () => {
    const context = setup({ start: at(12), projects: [project("a", null, 5 * MINUTE)] });
    context.faults.archiveFails = true;
    const { done } = await context.service.begin("a", { mode: null, manual: true, trigger: "manual" });
    expect(await done).toMatchObject({ outcome: "changed" });
    expect(await context.active()).toBeUndefined();
    expect(context.archived).toEqual([]);
    context.faults.archiveFails = false;
    await tick(context, context.service, 1);
    expect(context.archived).toEqual(["thr_a1"]);
  });
});

describe("a reload while a dream starts", () => {
  it("waits out the grace period, stops the thread nobody watches, and ends the run", async () => {
    const first = setup({ start: at(12), projects: [project("a", null)] });
    // The old copy goes away after `spawn` began but before it answered: kv still says spawning.
    first.faults.duringSpawn = () => first.service.dispose();
    await expect(first.service.begin("a", { mode: null, manual: true, trigger: "manual" })).rejects.toThrow(/reloaded/);
    expect((await first.active())?.phase).toBe("spawning");
    // The old copy stopped the thread it spawned on its way out; say it did not, to test the new copy.
    first.threads.get("thr_a1")!.stopped = false;

    const second = createDreamService(first.ports);
    await tick(first, second, 3);
    expect(await first.active()).toBeDefined();
    expect(first.finishes).toEqual([]);
    await tick(first, second, START_GRACE_MS / MINUTE);
    expect(await first.active()).toBeUndefined();
    expect(first.finishes).toEqual([expect.objectContaining({ ok: false })]);
    expect(first.threads.get("thr_a1")).toMatchObject({ stopped: true, archived: true });
    expect((await second.history.list())[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining("while the dream was starting") });
  });

  it("stops the thread it just spawned when it finds it was replaced meanwhile", async () => {
    const first = setup({ start: at(12), projects: [project("a", null)] });
    first.faults.duringSpawn = () => first.service.dispose();
    await expect(first.service.begin("a", { mode: null, manual: true, trigger: "manual" })).rejects.toThrow();
    expect(first.stopped).toEqual(["thr_a1"]);
    expect(first.sent).toEqual([]);
  });

  it("stops an orphaned dream thread when no run is recorded at all", async () => {
    const context = setup({ start: at(12), projects: [project("a", null)] });
    context.threads.set("thr_lost", { project: project("a", null), spawnedAt: context.now(), sentAt: null, stopped: false, archived: false });
    await tick(context, context.service, 1);
    expect(context.stopped).toEqual(["thr_lost"]);
    expect(context.archived).toEqual(["thr_lost"]);
  });
});

describe("the window's end", () => {
  it("starts no dream when the status scan runs past the window's end", async () => {
    const context = setup({ start: new Date(2026, 10, 17, 5, 59, 59), projects: [project("a", null)], config: { windowEnd: "06:00" } });
    context.faults.statusMs = 2_000;
    await context.service.sweep(new AbortController().signal);
    expect(context.order).toEqual([]);
    expect(context.finishes).toEqual([]);
  });

  it("ends a dream prepared past the window's end without starting its thread", async () => {
    const context = setup({ start: new Date(2026, 10, 17, 5, 59), projects: [project("a", null)], config: { windowEnd: "06:00" } });
    context.faults.prepareMs = 2 * MINUTE;
    await context.service.sweep(new AbortController().signal);
    expect(context.order).toEqual([]);
    expect(context.finishes).toEqual([expect.objectContaining({ ok: false })]);
    expect(await context.active()).toBeUndefined();
  });

  it("lets a dream that started inside the window finish after it", async () => {
    const context = setup({ start: new Date(2026, 10, 17, 5, 50), projects: [project("a", null, 30 * MINUTE)], config: { windowEnd: "06:00" } });
    await context.service.sweep(new AbortController().signal);
    expect(context.order).toEqual(["a"]);
    expect(context.finishes).toEqual([expect.objectContaining({ ok: true })]);
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
