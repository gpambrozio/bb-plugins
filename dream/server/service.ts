/**
 * The server's half of Dream: which projects the dream machine has, one dream from start to end,
 * the nightly sweep, and picking a dream back up after a reload. bb is reached only through
 * `DreamPorts`, so the tests drive all of it with fakes.
 *
 * A dream, from start to end:
 *
 * 1. the host takes the memory lock and backs up (or, for a dry run, copies) the memory folder, and
 *    writes the dream workspace (`host/dreams.ts`, `prepare`);
 * 2. a hidden Claude Code thread is spawned in that workspace, accept-edits, with the rendered dream
 *    prompt; the workspace's settings hold it to memory-only writes (`host/workspace.ts`);
 * 3. the thread is watched until its turn ends, it fails, it asks for anything, or 45 minutes pass;
 * 4. the host records what changed, or rolls the lock back (`finish`);
 * 5. the thread is stopped and archived, whatever happened;
 * 6. the run goes in the run log, and a dream that changed files (or a dry run that proposes changes)
 *    sends one push notification.
 *
 * Only one dream runs at a time, across the whole plugin. The one running is kept in kv
 * (`active-run`), so a reloaded plugin waits for it and finishes it instead of starting another.
 */
import { randomBytes } from "node:crypto";

import type { Choices, Outcome, Overview, RunRecord } from "../shared/contract-types";
import { mostOverdue, type Thresholds } from "../shared/gate";
import type { Changes, Finished, Mode, Prepared, ProjectInput, ProjectStatus } from "../shared/types";
import { inWindow, windowClosesAt, windowOpensAt } from "../shared/window";
import { createHistory, type KvLike } from "./history";
import { checkoutsOn, findCheckout, mapWorktreeFolders, type BbProjectRow, type Checkout, type ThreadProjectLookup } from "./projects";
import { renderPrompt } from "./prompt";

export const MAX_DREAM_MS = 45 * 60_000;
export const POLL_MS = 10_000;
/** Between sweeps that found nothing due, inside the window. */
export const SWEEP_EVERY_MS = 15 * 60_000;
/** A run recorded without its thread for this long was cut short while spawning. */
const SPAWN_GRACE_MS = 2 * 60_000;

const ACTIVE_KEY = "active-run";
const SWITCHES_KEY = "switches";
const THREADS_KEY = "thread-projects";
const LAST_SWEEP_KEY = "last-sweep";
const STOP_KEY = "stop-requested";

export interface DreamConfig {
  scheduleEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  thresholds: Thresholds;
  backupsToKeep: number;
  notify: boolean;
  choices: Choices;
}

export type ThreadState =
  | { kind: "running" }
  | { kind: "finished" }
  | { kind: "failed"; error: string }
  | { kind: "asking" }
  | { kind: "gone" };

export interface HostPort {
  scan(hostId: string): Promise<{ worktreeFolders: Array<{ name: string; threadId: string; repoSlug: string }> }>;
  status(hostId: string, input: { projects: ProjectInput[]; thresholds: Thresholds }): Promise<{ projects: ProjectStatus[] }>;
  prepare(hostId: string, input: { runId: string; project: ProjectInput; mode: Mode | null; manual: boolean; thresholds: Thresholds; backupsToKeep: number }): Promise<Prepared>;
  finish(hostId: string, input: { runId: string; ok: boolean; summary: string | null; threadId: string | null }): Promise<Finished>;
  apply(hostId: string, input: { project: ProjectInput; stamp?: string; backupsToKeep: number }): Promise<{ stamp: string; changes: Changes; backup: string }>;
  discard(hostId: string, input: { project: ProjectInput; stamp?: string }): Promise<{ stamp: string }>;
  restore(hostId: string, input: { project: ProjectInput; stamp?: string; backupsToKeep: number }): Promise<{ stamp: string; changes: Changes; backup: string }>;
  backups(hostId: string, input: { project: ProjectInput }): Promise<{ backups: Array<{ stamp: string; size: number }>; proposals: ProjectStatus["pendingProposal"][] }>;
  activeRuns(hostId: string): Promise<{ runs: Array<{ runId: string; projectId: string; startedAt: number }> }>;
}

export interface SpawnRequest {
  runId: string;
  projectId: string;
  projectName: string;
  hostId: string;
  workspace: string;
  prompt: string;
  model: string;
  reasoningLevel: string;
}

export interface DreamPorts {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  config(): Promise<DreamConfig>;
  saveChoices(choices: Choices): Promise<void>;
  primaryHostId(): Promise<string | null>;
  hosts(): Promise<Array<{ id: string; name: string; connected: boolean }>>;
  projects(): Promise<BbProjectRow[]>;
  threadProject: ThreadProjectLookup;
  host: HostPort;
  threads: {
    spawn(request: SpawnRequest): Promise<string>;
    state(threadId: string): Promise<ThreadState>;
    output(threadId: string): Promise<string | null>;
    stop(threadId: string): Promise<void>;
    archive(threadId: string): Promise<void>;
  };
  kv: KvLike;
  notify(title: string, body: string): Promise<void>;
  /** Tells open pages that something changed. */
  publish(): void;
}

export class DreamError extends Error {}

function newRunId(): string {
  return randomBytes(6).toString("hex");
}

export function changeText(changes: Changes, conditional = false): string {
  const parts: string[] = [];
  if (changes.changed.length > 0) parts.push(`${conditional ? "update" : "updated"} ${changes.changed.length}`);
  if (changes.added.length > 0) parts.push(`${conditional ? "add" : "added"} ${changes.added.length}`);
  if (changes.deleted.length > 0) parts.push(`${conditional ? "remove" : "removed"} ${changes.deleted.length}`);
  const total = changes.changed.length + changes.added.length + changes.deleted.length;
  if (parts.length === 0) return "no memory files changed";
  const text = `${parts.join(", ")} memory ${total === 1 ? "file" : "files"}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function totalChanges(changes: Changes | null): number {
  return changes === null ? 0 : changes.added.length + changes.changed.length + changes.deleted.length;
}

export function createDreamService(ports: DreamPorts) {
  const history = createHistory(ports.kv);
  /** The completion of the dream this instance is running or watching, if any. */
  let running: Promise<RunRecord> | null = null;
  /** Projects the sweep already tried in the window that is open now. */
  let attempted = new Set<string>();
  let disposed = false;
  const lifetime = new AbortController();

  async function dreamHost(): Promise<string> {
    const { choices } = await ports.config();
    const hostId = choices.hostId ?? (await ports.primaryHostId());
    if (hostId === null) throw new DreamError("bb has no primary machine; choose the dream machine in Dream's settings.");
    return hostId;
  }

  async function switches(): Promise<Record<string, boolean>> {
    return (await ports.kv.get<Record<string, boolean>>(SWITCHES_KEY)) ?? {};
  }

  /** The dream machine's projects as the host needs them: checkout, switch and worktree folders. */
  async function projectInputs(hostId: string): Promise<ProjectInput[]> {
    const checkouts = checkoutsOn(await ports.projects(), hostId);
    const scan = await ports.host.scan(hostId);
    const known = (await ports.kv.get<Record<string, string | null>>(THREADS_KEY)) ?? {};
    const mapping = await mapWorktreeFolders(scan.worktreeFolders, checkouts, known, ports.threadProject);
    if (Object.keys(mapping.learned).length > 0) {
      // Only threads that still have a folder are kept, so the cache does not grow for ever.
      const present = new Set(scan.worktreeFolders.map((folder) => folder.threadId));
      const merged = Object.fromEntries(Object.entries({ ...known, ...mapping.learned }).filter(([threadId]) => present.has(threadId)));
      await ports.kv.set(THREADS_KEY, merged);
    }
    const enabled = await switches();
    return checkouts.map((checkout: Checkout) => ({
      ...checkout,
      // A project is on until it is turned off; nothing runs until the schedule is turned on.
      enabled: enabled[checkout.projectId] ?? true,
      worktreeFolders: mapping.byProject.get(checkout.projectId) ?? [],
    }));
  }

  async function statuses(hostId: string): Promise<ProjectStatus[]> {
    const config = await ports.config();
    return (await ports.host.status(hostId, { projects: await projectInputs(hostId), thresholds: config.thresholds })).projects;
  }

  async function activeRecord(): Promise<RunRecord | null> {
    return (await ports.kv.get<RunRecord>(ACTIVE_KEY)) ?? null;
  }

  async function saveActive(record: RunRecord | null): Promise<void> {
    if (record === null) await ports.kv.delete(ACTIVE_KEY);
    else await ports.kv.set(ACTIVE_KEY, record);
  }

  async function record(entry: RunRecord): Promise<void> {
    await history.put(entry);
    ports.publish();
  }

  async function notifyAbout(entry: RunRecord, config: DreamConfig): Promise<void> {
    if (!config.notify || totalChanges(entry.changes) === 0 || entry.changes === null) return;
    const title = entry.outcome === "proposed" ? `Dream proposal: ${entry.projectName}` : `Dream: ${entry.projectName}`;
    const body =
      entry.outcome === "proposed"
        ? `Would ${changeText(entry.changes, true).toLowerCase()}. Review it on the Dream page, or run bb dream apply ${entry.projectName}.`
        : `${changeText(entry.changes)}.`;
    try {
      await ports.notify(title, body);
    } catch (error) {
      ports.log.warn(`Could not send the push notification for ${entry.projectName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Watches a dream's thread until it ends; answers how it ended. */
  async function watch(entry: RunRecord, signal: AbortSignal): Promise<{ ok: boolean; error: string | null } | "aborted"> {
    const threadId = entry.threadId as string;
    const deadline = entry.startedAt + MAX_DREAM_MS;
    for (;;) {
      if (signal.aborted) return "aborted";
      if ((await ports.kv.get<string>(STOP_KEY)) === entry.runId) return { ok: false, error: "Stopped by hand." };
      let state: ThreadState;
      try {
        state = await ports.threads.state(threadId);
      } catch (error) {
        ports.log.warn(`Could not read dream thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        state = { kind: "running" };
      }
      if (state.kind === "finished") return { ok: true, error: null };
      if (state.kind === "failed") return { ok: false, error: state.error };
      if (state.kind === "gone") return { ok: false, error: "The dream thread was deleted." };
      if (state.kind === "asking") return { ok: false, error: "The dream thread asked for something, which a dream must never do; it was stopped." };
      if (ports.now() >= deadline) return { ok: false, error: `The dream ran past ${MAX_DREAM_MS / 60_000} minutes and was stopped.` };
      await ports.sleep(POLL_MS, signal);
    }
  }

  async function cleanUp(threadId: string): Promise<void> {
    try {
      await ports.threads.stop(threadId);
    } catch (error) {
      ports.log.warn(`Could not stop dream thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await ports.threads.archive(threadId);
    } catch (error) {
      ports.log.warn(`Could not archive dream thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Steps 3–6 for a run whose thread exists. Leaves the run in place when this instance is going away. */
  async function complete(entry: RunRecord, signal: AbortSignal): Promise<RunRecord> {
    const ended = await watch(entry, signal);
    if (ended === "aborted") return entry;
    const threadId = entry.threadId as string;
    let summary: string | null = null;
    if (ended.ok) {
      try {
        summary = await ports.threads.output(threadId);
      } catch (error) {
        ports.log.warn(`Could not read the dream's summary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Stopped before finishing, so a thread that overran cannot write after the lock is rolled back.
    await cleanUp(threadId);
    return finishRun(entry, ended.ok, summary, ended.error);
  }

  async function finishRun(entry: RunRecord, ok: boolean, summary: string | null, error: string | null): Promise<RunRecord> {
    const config = await ports.config();
    let finished: Finished | null = null;
    let finishError: string | null = null;
    try {
      finished = await ports.host.finish(entry.hostId, { runId: entry.runId, ok, summary, threadId: entry.threadId });
    } catch (caught) {
      finishError = caught instanceof Error ? caught.message : String(caught);
    }
    let outcome: Outcome = "failed";
    if (ok && finished !== null) {
      const count = totalChanges(finished.changes);
      outcome = finished.mode === "dry-run" ? (count > 0 ? "proposed" : "unchanged") : count > 0 ? "changed" : "unchanged";
    }
    const done: RunRecord = {
      ...entry,
      endedAt: ports.now(),
      outcome,
      changes: finished?.changes ?? null,
      summary,
      proposal: finished?.proposal ?? entry.proposal,
      error: error ?? finishError,
    };
    await record(done);
    await saveActive(null);
    await ports.kv.delete(STOP_KEY);
    await notifyAbout(done, config);
    await history.prune();
    return done;
  }

  /**
   * Steps 1 and 2: answers once the thread is spawned, with the rest running on. Throws a
   * `DreamError` with the host's reason when the project is refused.
   */
  async function begin(projectId: string, options: { mode: Mode | null; manual: boolean; trigger: RunRecord["trigger"] }): Promise<{ record: RunRecord; done: Promise<RunRecord> }> {
    if (running !== null || (await activeRecord()) !== null) {
      const active = await activeRecord();
      throw new DreamError(`A dream is already running${active ? ` for ${active.projectName}` : ""}; dreams run one at a time.`);
    }
    const config = await ports.config();
    const hostId = await dreamHost();
    const inputs = await projectInputs(hostId);
    const project = inputs.find((candidate) => candidate.projectId === projectId);
    if (project === undefined) throw new DreamError(`Project ${projectId} has no checkout on the dream machine.`);
    const runId = newRunId();
    const prepared = await ports.host.prepare(hostId, {
      runId,
      project,
      mode: options.mode,
      manual: options.manual,
      thresholds: config.thresholds,
      backupsToKeep: config.backupsToKeep,
    });
    if (!prepared.ok) throw new DreamError(`${project.name}: ${prepared.reason}`);

    let entry: RunRecord = {
      runId,
      projectId,
      projectName: project.name,
      hostId,
      mode: prepared.mode,
      trigger: options.trigger,
      startedAt: ports.now(),
      endedAt: null,
      outcome: "running",
      threadId: null,
      changes: null,
      summary: null,
      backup: prepared.backup,
      proposal: prepared.proposal,
      error: null,
    };
    await saveActive(entry);
    try {
      const threadId = await ports.threads.spawn({
        runId,
        projectId,
        projectName: project.name,
        hostId,
        workspace: prepared.workspace,
        prompt: renderPrompt(prepared),
        model: config.choices.model,
        reasoningLevel: config.choices.reasoningLevel,
      });
      entry = { ...entry, threadId };
      await saveActive(entry);
      await record(entry);
    } catch (error) {
      const failed = await finishRun(entry, false, null, `Could not start the dream thread: ${error instanceof Error ? error.message : String(error)}`);
      throw new DreamError(failed.error ?? "Could not start the dream thread.");
    }
    const done = complete(entry, lifetime.signal).finally(() => {
      running = null;
    });
    running = done;
    return { record: entry, done };
  }

  /** Picks up a dream a previous copy of the plugin left running, and ends runs the host holds that nobody watches. */
  async function recover(): Promise<void> {
    const active = await activeRecord();
    if (active !== null && running === null) {
      if (active.threadId !== null) {
        ports.log.info(`Picking up the dream for ${active.projectName} where the plugin left it.`);
        running = complete(active, lifetime.signal).finally(() => {
          running = null;
        });
        await running;
      } else if (ports.now() - active.startedAt > SPAWN_GRACE_MS) {
        await finishRun(active, false, null, "bb reloaded the plugin while the dream thread was starting.");
      } else {
        return;
      }
    }
    try {
      const hostId = await dreamHost();
      const { runs } = await ports.host.activeRuns(hostId);
      const current = await activeRecord();
      for (const run of runs) {
        if (current?.runId === run.runId || ports.now() - run.startedAt < MAX_DREAM_MS + SPAWN_GRACE_MS) continue;
        ports.log.warn(`Ending a dream the server lost track of (run ${run.runId}).`);
        await ports.host.finish(hostId, { runId: run.runId, ok: false, summary: null, threadId: null });
      }
    } catch (error) {
      ports.log.warn(`Could not check the dream machine for leftover dreams: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One night's work: inside the window, the most overdue due project, one at a time, until none is
   * due or the window closes. A project is tried once per window, so a failing one cannot loop.
   */
  async function sweep(signal: AbortSignal): Promise<number> {
    let dreams = 0;
    for (;;) {
      if (signal.aborted || disposed) break;
      const config = await ports.config();
      if (!config.scheduleEnabled || !inWindow(new Date(ports.now()), config.windowStart, config.windowEnd)) break;
      if (running !== null || (await activeRecord()) !== null) break;
      const hostId = await dreamHost();
      const candidates = (await statuses(hostId)).filter((status) => status.enabled && !attempted.has(status.projectId));
      const pick = mostOverdue(candidates);
      if (pick === null) break;
      attempted.add(pick.projectId);
      try {
        const { done } = await begin(pick.projectId, { mode: null, manual: false, trigger: "schedule" });
        await done;
        dreams += 1;
      } catch (error) {
        ports.log.warn(`Dream for ${pick.name} did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await ports.kv.set(LAST_SWEEP_KEY, ports.now());
    return dreams;
  }

  /** The background loop: recover, then sweep whenever the window is open and a sweep is due. */
  async function loop(signal: AbortSignal): Promise<void> {
    await recover();
    let lastSweep: number | null = null;
    while (!signal.aborted && !disposed) {
      try {
        const config = await ports.config();
        const open = config.scheduleEnabled && inWindow(new Date(ports.now()), config.windowStart, config.windowEnd);
        if (!open) attempted = new Set();
        else if (lastSweep === null || ports.now() - lastSweep >= SWEEP_EVERY_MS) {
          await sweep(signal);
          lastSweep = ports.now();
        }
      } catch (error) {
        ports.log.warn(`The dream sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await ports.sleep(60_000, signal);
    }
  }

  async function checkoutOf(projectId: string): Promise<{ hostId: string; project: ProjectInput }> {
    const hostId = await dreamHost();
    const project = (await projectInputs(hostId)).find((candidate) => candidate.projectId === projectId);
    if (project === undefined) throw new DreamError(`Project ${projectId} has no checkout on the dream machine.`);
    return { hostId, project };
  }

  return {
    history,
    begin,
    recover,
    sweep,
    loop,
    statuses: async () => statuses(await dreamHost()),
    dreamHost,

    async findProject(query: string): Promise<Checkout> {
      const hostId = await dreamHost();
      try {
        return findCheckout(checkoutsOn(await ports.projects(), hostId), query);
      } catch (error) {
        throw new DreamError(error instanceof Error ? error.message : String(error));
      }
    },

    async overview(): Promise<Overview> {
      const config = await ports.config();
      const hosts = await ports.hosts();
      const hostId = await dreamHost();
      const host = hosts.find((candidate) => candidate.id === hostId) ?? null;
      const now = new Date(ports.now());
      const open = inWindow(now, config.windowStart, config.windowEnd);
      const next = open ? windowClosesAt(now, config.windowStart, config.windowEnd) : windowOpensAt(now, config.windowStart, config.windowEnd);
      let projects: ProjectStatus[] = [];
      let error: string | null = null;
      try {
        projects = await statuses(hostId);
      } catch (caught) {
        error = `Could not read the projects on ${host?.name ?? "the dream machine"}: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
      return {
        host,
        hosts,
        choices: config.choices,
        schedule: {
          enabled: config.scheduleEnabled,
          windowStart: config.windowStart,
          windowEnd: config.windowEnd,
          inWindow: open,
          nextChange: next?.getTime() ?? null,
          lastSweepAt: (await ports.kv.get<number>(LAST_SWEEP_KEY)) ?? null,
        },
        projects,
        active: await activeRecord(),
        error,
      };
    },

    async setSwitch(projectId: string, enabled: boolean): Promise<void> {
      const current = await switches();
      await ports.kv.set(SWITCHES_KEY, { ...current, [projectId]: enabled });
      ports.publish();
    },

    async setChoices(changes: Partial<Choices>): Promise<Choices> {
      if ((await activeRecord()) !== null && changes.hostId !== undefined) {
        throw new DreamError("A dream is running; change the machine once it has finished.");
      }
      const next = { ...(await ports.config()).choices, ...changes };
      await ports.saveChoices(next);
      ports.publish();
      return next;
    },

    /** Asks the watcher to stop the running dream; it ends as failed, with the lock rolled back. */
    async stopActive(): Promise<boolean> {
      const active = await activeRecord();
      if (active === null || active.threadId === null) return false;
      await ports.kv.set(STOP_KEY, active.runId);
      return true;
    },

    async apply(projectId: string, stamp?: string) {
      const { hostId, project } = await checkoutOf(projectId);
      const result = await ports.host.apply(hostId, { project, stamp, backupsToKeep: (await ports.config()).backupsToKeep });
      ports.publish();
      return result;
    },

    async discard(projectId: string, stamp?: string) {
      const { hostId, project } = await checkoutOf(projectId);
      const result = await ports.host.discard(hostId, { project, stamp });
      ports.publish();
      return result;
    },

    async restore(projectId: string, stamp?: string) {
      if ((await activeRecord())?.projectId === projectId) throw new DreamError("A dream is running for this project; restore once it has finished.");
      const { hostId, project } = await checkoutOf(projectId);
      const result = await ports.host.restore(hostId, { project, stamp, backupsToKeep: (await ports.config()).backupsToKeep });
      ports.publish();
      return result;
    },

    async backups(projectId: string) {
      const { hostId, project } = await checkoutOf(projectId);
      return ports.host.backups(hostId, { project });
    },

    /** Stops watching. A dream still running is left for the next copy of the plugin to finish. */
    dispose(): void {
      disposed = true;
      lifetime.abort();
    },
  };
}

export type DreamService = ReturnType<typeof createDreamService>;
