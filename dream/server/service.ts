/**
 * The server's half of Dream: which projects the dream machine has, one dream from start to end,
 * the nightly sweep, and picking a dream back up after a reload. bb is reached only through
 * `DreamPorts`, so the tests drive all of it with fakes.
 *
 * A dream is a state machine whose state is kept in kv (`active-run`) at every step, so whichever copy
 * of the plugin is loaded can carry it on, and every step is retried on the next loop tick when it
 * fails:
 *
 * - **preparing**: the host takes the memory lock, backs up (or copies, for a dry run) the memory, and
 *   writes the dream workspace (`host/dreams.ts`, `prepare`);
 * - **spawning**: a hidden Claude Code thread starts in that workspace, accept-edits, with nothing but
 *   the startup check: Write the canary file;
 * - **checking**: when that turn ends, the host checks the guard logged the Write and its failing
 *   companion hook blocked it (`checkCanary`). Only then is the dream prompt, with its transcripts,
 *   sent. A guard that cannot be proven active never sees untrusted text;
 * - **running**: the dream turn, watched until it ends, fails, asks for anything, is stopped by hand,
 *   or 45 minutes pass;
 * - **stopping**: the thread is stopped, and the run waits here, retrying, until bb confirms it is not
 *   running. Nothing releases the lock while a writer may still be alive;
 * - **finishing**: the host records what changed or rolls the lock back (`finish`, which may be asked
 *   again). The kv marker is cleared only once the host answers; then the run is logged, the thread
 *   archived (retried later if that fails) and one push notification sent when files changed.
 *
 * Only one dream runs at a time, across the whole plugin. A run left in preparing or spawning by a
 * copy that went away is ended after `START_GRACE_MS`, after stopping any thread of this plugin that
 * is still open; with no run in kv, any such thread is an orphan and is stopped too.
 */
import { randomBytes } from "node:crypto";

import type { Choices, Outcome, Overview, RunRecord } from "../shared/contract-types";
import { dreamEligible } from "../shared/filters";
import { changeText, linksText, totalChanges } from "../shared/format";
import { mostOverdue, type Thresholds } from "../shared/gate";
import type { Changes, Finished, Mode, Prepared, ProjectInput, ProjectStatus, ProposalDiff } from "../shared/types";
import { inWindow, windowClosesAt, windowOpensAt } from "../shared/window";
import { createHistory, type KvLike } from "./history";
import { checkoutsOn, findCheckout, mapWorktreeFolders, type BbProjectRow, type Checkout, type ThreadProjectLookup } from "./projects";
import { renderPrompt } from "./prompt";

export { MAX_DREAM_MS } from "./limits";
import { MAX_DREAM_MS } from "./limits";
export const POLL_MS = 10_000;
/** Between sweeps that found nothing due, inside the window. */
export const SWEEP_EVERY_MS = 15 * 60_000;
/** A run still preparing or spawning this long after it began was left by a copy that went away. */
export const START_GRACE_MS = 10 * 60_000;
/** How long a stop is given to take effect before it is tried again on a later tick. */
const STOP_CONFIRM_TRIES = 3;
const STOP_CONFIRM_WAIT_MS = 2_000;

const ACTIVE_KEY = "active-run";
const SWITCHES_KEY = "switches";
const THREADS_KEY = "thread-projects";
const LAST_SWEEP_KEY = "last-sweep";
const STOP_KEY = "stop-requested";
const ARCHIVE_KEY = "to-archive";
/** Set while a thread of this plugin could not be confirmed stopped; no clean-up or start passes it. */
const ORPHAN_KEY = "orphans-unconfirmed";

/** The error text Claude Code gives a call its failing hook blocked under `onFailure: "block"`. */
const ON_FAILURE_BLOCK = 'onFailure is "block"';
const COMPANION_FLAG = "--canary-fail";

/**
 * Whether the canary Write was blocked by the plugin's companion hook under `onFailure: "block"`,
 * judged from the errors bb recorded for that Write. Another hook denying the call (a user's, say) leaves
 * a different error, so the proof is bound to the handler it is about, and a Claude Code that ignored
 * `onFailure` cannot pass it. A future rewording of that message fails the check, which fails closed.
 */
export function blockedByCompanion(errors: readonly string[]): boolean {
  return errors.some((error) => error.includes(COMPANION_FLAG) && error.includes(ON_FAILURE_BLOCK));
}

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
  checkCanary(hostId: string, input: { runId: string }): Promise<{ ok: boolean; reason: string }>;
  finish(hostId: string, input: { runId: string; ok: boolean; summary: string | null; threadId: string | null }): Promise<Finished>;
  apply(hostId: string, input: { project: ProjectInput; stamp?: string; backupsToKeep: number }): Promise<{ stamp: string; changes: Changes; backup: string }>;
  discard(hostId: string, input: { project: ProjectInput; stamp?: string }): Promise<{ stamp: string }>;
  restore(hostId: string, input: { project: ProjectInput; stamp?: string; backupsToKeep: number }): Promise<{ stamp: string; changes: Changes; backup: string }>;
  backups(hostId: string, input: { project: ProjectInput }): Promise<{ backups: Array<{ stamp: string; size: number }>; proposals: ProjectStatus["pendingProposal"][] }>;
  proposalDiff(hostId: string, input: { project: ProjectInput; stamp?: string }): Promise<ProposalDiff>;
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
    send(threadId: string, text: string): Promise<void>;
    /** The errors bb recorded for the thread's failed Writes of `file`. */
    writeErrors(threadId: string, file: string): Promise<string[]>;
    /** The thread's state once `turns` turns should have completed. */
    state(threadId: string, turns: number): Promise<ThreadState>;
    output(threadId: string): Promise<string | null>;
    stop(threadId: string): Promise<void>;
    /** True when bb says the thread is not running (idle, failed, or gone). */
    stopped(threadId: string): Promise<boolean>;
    archive(threadId: string): Promise<void>;
    /** This plugin's threads that are not archived. */
    listOpen(): Promise<string[]>;
  };
  kv: KvLike;
  notify(title: string, body: string): Promise<void>;
  /** Tells open pages that something changed. */
  publish(): void;
}

export type Phase = "preparing" | "spawning" | "checking" | "running" | "stopping" | "finishing";

export interface Ended {
  ok: boolean;
  summary: string | null;
  error: string | null;
}

/** The run in progress, as kept in kv between steps. */
export interface ActiveState {
  record: RunRecord;
  phase: Phase;
  /** The startup check's file, whose blocked Write proves the guard. */
  canary: string | null;
  /** The dream prompt, sent once the startup check passes. */
  prompt: string | null;
  ended: Ended | null;
}

export class DreamError extends Error {}

function newRunId(): string {
  return randomBytes(6).toString("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first turn of every dream thread: no transcript, no memory, nothing untrusted. */
export function canaryPrompt(canary: string): string {
  return [
    "Dream startup check. Before anything else, use the Write tool exactly once to create the file",
    `\`${canary}\``,
    "with the single word `canary` as its content. The call is expected to be blocked. Then reply with one short line saying what happened, and do nothing else.",
  ].join("\n");
}

export function createDreamService(ports: DreamPorts) {
  const history = createHistory(ports.kv);
  /** The run this instance is carrying on, if any. */
  let running: Promise<RunRecord> | null = null;
  /** Set from the first await of `begin` until its run is recorded, so two starts cannot both pass the check. */
  let starting = false;
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

  async function loadActive(): Promise<ActiveState | null> {
    return (await ports.kv.get<ActiveState>(ACTIVE_KEY)) ?? null;
  }

  async function activeRecord(): Promise<RunRecord | null> {
    return (await loadActive())?.record ?? null;
  }

  /**
   * Writes the run's state, fenced: never from a copy that has been disposed, and never over another
   * run's marker (one that started after this run was finished by another copy). Answers whether it
   * wrote. bb loads a new copy before it disposes the old one, so both may drive the same run for a
   * moment; the fence keeps the old one's late answers from touching what the new one owns.
   */
  async function saveActive(state: ActiveState): Promise<boolean> {
    if (disposed) return false;
    const current = await loadActive();
    if (current !== null && current.record.runId !== state.record.runId) return false;
    await ports.kv.set(ACTIVE_KEY, state);
    ports.publish();
    return true;
  }

  /** Clears the marker of `runId` only, and its stop request; never another run's. */
  async function clearActive(runId: string): Promise<void> {
    const current = await loadActive();
    if (current !== null && current.record.runId !== runId) return;
    await ports.kv.delete(ACTIVE_KEY);
    if ((await ports.kv.get<string>(STOP_KEY)) === runId) await ports.kv.delete(STOP_KEY);
    ports.publish();
  }

  async function notifyAbout(entry: RunRecord, config: DreamConfig): Promise<void> {
    if (!config.notify || totalChanges(entry.changes) === 0 || entry.changes === null) return;
    const title = entry.outcome === "proposed" ? `Dream proposal: ${entry.projectName}` : `Dream: ${entry.projectName}`;
    const body =
      entry.outcome === "proposed"
        ? `Would ${changeText(entry.changes, true).toLowerCase()}. Review it on the Dream page, or run bb dream apply ${entry.projectName}.`
        : `${changeText(entry.changes)}.`;
    const links = linksText(entry.danglingLinks);
    try {
      await ports.notify(title, links ? `${body} ${links}: see the Dream page.` : body);
    } catch (error) {
      ports.log.warn(`Could not send the push notification for ${entry.projectName}: ${message(error)}`);
    }
  }

  /** Watches a thread until its `turns`-th turn ends; answers how it ended, or "aborted". */
  async function watch(record: RunRecord, turns: number, signal: AbortSignal): Promise<Ended | "aborted"> {
    const threadId = record.threadId as string;
    const deadline = record.startedAt + MAX_DREAM_MS;
    for (;;) {
      if (signal.aborted) return "aborted";
      if ((await ports.kv.get<string>(STOP_KEY)) === record.runId) return { ok: false, summary: null, error: "Stopped by hand." };
      let state: ThreadState;
      try {
        state = await ports.threads.state(threadId, turns);
      } catch (error) {
        ports.log.warn(`Could not read dream thread ${threadId}: ${message(error)}`);
        state = { kind: "running" };
      }
      if (state.kind === "finished") return { ok: true, summary: null, error: null };
      if (state.kind === "failed") return { ok: false, summary: null, error: state.error };
      if (state.kind === "gone") return { ok: false, summary: null, error: "The dream thread was deleted." };
      if (state.kind === "asking") return { ok: false, summary: null, error: "The dream thread asked for something, which a dream must never do; it was stopped." };
      if (ports.now() >= deadline) return { ok: false, summary: null, error: `The dream ran past ${MAX_DREAM_MS / 60_000} minutes and was stopped.` };
      await ports.sleep(POLL_MS, signal);
    }
  }

  /** Stops a thread and waits for bb to confirm it is not running; false when it could not confirm. */
  async function stopAndConfirm(threadId: string, signal: AbortSignal): Promise<boolean> {
    try {
      await ports.threads.stop(threadId);
    } catch (error) {
      ports.log.warn(`Could not stop dream thread ${threadId}: ${message(error)}`);
    }
    for (let attempt = 0; attempt < STOP_CONFIRM_TRIES; attempt++) {
      try {
        if (await ports.threads.stopped(threadId)) return true;
      } catch (error) {
        ports.log.warn(`Could not read dream thread ${threadId}: ${message(error)}`);
      }
      if (signal.aborted) return false;
      await ports.sleep(STOP_CONFIRM_WAIT_MS, signal);
    }
    return false;
  }

  async function archive(threadId: string): Promise<void> {
    try {
      await ports.threads.archive(threadId);
    } catch (error) {
      ports.log.warn(`Could not archive dream thread ${threadId}; will try again: ${message(error)}`);
      const pending = (await ports.kv.get<string[]>(ARCHIVE_KEY)) ?? [];
      if (!pending.includes(threadId)) await ports.kv.set(ARCHIVE_KEY, [...pending, threadId]);
    }
  }

  async function retryArchives(): Promise<void> {
    const pending = (await ports.kv.get<string[]>(ARCHIVE_KEY)) ?? [];
    if (pending.length === 0) return;
    const left: string[] = [];
    for (const threadId of pending) {
      try {
        await ports.threads.archive(threadId);
      } catch {
        left.push(threadId);
      }
    }
    await ports.kv.set(ARCHIVE_KEY, left);
  }

  /**
   * Stops every open thread of this plugin; true when all are confirmed stopped. While one is not,
   * `ORPHAN_KEY` stays set, and it blocks the host's clean-up and every new start.
   */
  async function stopOrphans(signal: AbortSignal): Promise<boolean> {
    let all = true;
    for (const threadId of await ports.threads.listOpen()) {
      ports.log.warn(`Stopping dream thread ${threadId}, which no run is watching.`);
      if (await stopAndConfirm(threadId, signal)) await archive(threadId);
      else all = false;
    }
    if (disposed) return all;
    if (all) await ports.kv.delete(ORPHAN_KEY);
    else await ports.kv.set(ORPHAN_KEY, ports.now());
    return all;
  }

  /**
   * Asks the host to end the run, then logs it, clears the marker, archives the thread and notifies.
   * Answers null, keeping the marker for a later tick, when the host did not answer.
   */
  async function finalize(state: ActiveState): Promise<RunRecord | null> {
    const ended = state.ended ?? { ok: false, summary: null, error: "The dream ended without a result." };
    const entry = state.record;
    let finished: Finished;
    try {
      finished = await ports.host.finish(entry.hostId, { runId: entry.runId, ok: ended.ok, summary: ended.summary, threadId: entry.threadId });
    } catch (error) {
      ports.log.warn(`Could not end the dream for ${entry.projectName} on the dream machine; will try again: ${message(error)}`);
      if (state.phase !== "finishing") await saveActive({ ...state, phase: "finishing" });
      return null;
    }
    // Another copy finished this run meanwhile, and a newer run may own the marker: leave it be.
    const current = await loadActive();
    if (disposed || current === null || current.record.runId !== entry.runId) return null;
    let outcome: Outcome = "failed";
    if (ended.ok && finished.found) {
      const count = totalChanges(finished.changes);
      outcome = finished.mode === "dry-run" ? (count > 0 ? "proposed" : "unchanged") : count > 0 ? "changed" : "unchanged";
    }
    const done: RunRecord = {
      ...entry,
      endedAt: ports.now(),
      outcome,
      changes: finished.found ? finished.changes : null,
      summary: ended.summary,
      // The host names a proposal only when one waits; a dry run that changed nothing leaves none.
      proposal: finished.found ? finished.proposal : entry.proposal,
      error: [ended.error ?? (finished.found ? null : "The dream machine had no record of this run."), finished.found ? finished.warning : null].filter(Boolean).join(" ") || null,
      danglingLinks: finished.found ? finished.danglingLinks : [],
    };
    await history.put(done);
    await clearActive(entry.runId);
    if (entry.threadId) await archive(entry.threadId);
    await notifyAbout(done, await ports.config());
    await history.prune();
    return done;
  }

  /** Thrown when this copy may no longer write the run's state: disposed, or the run is another's. */
  class Superseded extends Error {}

  async function advance(next: ActiveState): Promise<ActiveState> {
    if (!(await saveActive(next))) throw new Superseded();
    return next;
  }

  async function toStopping(state: ActiveState, ended: Ended): Promise<ActiveState> {
    return advance({ ...state, phase: "stopping", ended });
  }

  /**
   * Carries a run on from whatever step it is in, until it is finished or must wait for a later tick.
   * Answers the record: finished, or as it stands while it waits.
   */
  async function drive(initial: ActiveState, signal: AbortSignal): Promise<RunRecord> {
    try {
      return await driveSteps(initial, signal);
    } catch (error) {
      if (error instanceof Superseded) return initial.record;
      throw error;
    }
  }

  async function driveSteps(initial: ActiveState, signal: AbortSignal): Promise<RunRecord> {
    let state = initial;
    for (;;) {
      if (signal.aborted) return state.record;
      const { record } = state;
      switch (state.phase) {
        case "preparing":
        case "spawning": {
          // Only a copy that went away leaves a run here; give it time, then end it.
          if (ports.now() - record.startedAt < START_GRACE_MS) return record;
          if (!(await stopOrphans(signal))) return record;
          state = await advance({ ...state, phase: "finishing", ended: { ok: false, summary: null, error: "bb reloaded the plugin while the dream was starting." } });
          break;
        }
        case "checking": {
          const turn = await watch(record, 1, signal);
          if (turn === "aborted") return record;
          if (!turn.ok) {
            state = await toStopping(state, turn);
            break;
          }
          let proof: { ok: boolean; reason: string };
          try {
            // First what bb saw (the companion hook's own block), then the host (guard log, file), which
            // arms the guard only on a pass.
            const errors = state.canary === null ? [] : await ports.threads.writeErrors(record.threadId as string, state.canary);
            proof = blockedByCompanion(errors)
              ? await ports.host.checkCanary(record.hostId, { runId: record.runId })
              : { ok: false, reason: "the check's Write was not blocked by the plugin's own failing hook under onFailure \"block\"" };
          } catch (error) {
            proof = { ok: false, reason: `the check could not be read: ${message(error)}` };
          }
          if (!proof.ok || state.prompt === null) {
            state = await toStopping(state, { ok: false, summary: null, error: `The dream's guard could not be proven active, so no dream ran: ${proof.reason}.` });
            break;
          }
          // The send is a side effect, fenced like a state write: only the copy that still owns this run,
          // with the run still in checking, may send, and it records "running" first, so no other copy
          // sends it again. A copy disposed, or overtaken, while the proof was in flight sends nothing.
          const current = await loadActive();
          if (disposed || current === null || current.record.runId !== record.runId || current.phase !== "checking") throw new Superseded();
          state = await advance({ ...state, phase: "running" });
          try {
            await ports.threads.send(record.threadId as string, state.prompt as string);
          } catch (error) {
            state = await toStopping(state, { ok: false, summary: null, error: `Could not send the dream prompt: ${message(error)}` });
          }
          break;
        }
        case "running": {
          const turn = await watch(record, 2, signal);
          if (turn === "aborted") return record;
          let ended = turn;
          if (turn.ok) {
            let summary: string | null = null;
            try {
              summary = await ports.threads.output(record.threadId as string);
            } catch (error) {
              ports.log.warn(`Could not read the dream's summary: ${message(error)}`);
            }
            ended = { ok: true, summary, error: null };
          }
          state = await toStopping(state, ended);
          break;
        }
        case "stopping": {
          // The lock stays taken until bb confirms the thread is not running.
          if (record.threadId !== null && !(await stopAndConfirm(record.threadId, signal))) {
            ports.log.warn(`Dream thread ${record.threadId} is not confirmed stopped; its run keeps the lock and is retried.`);
            return record;
          }
          state = await advance({ ...state, phase: "finishing" });
          break;
        }
        case "finishing":
          return (await finalize(state)) ?? record;
      }
    }
  }

  /**
   * Steps preparing and spawning: answers once the thread is spawned, with the rest running on.
   * Throws a `DreamError` with the reason when the project is refused, the start fails, or the window
   * (`notAfter`) closes before the thread starts.
   */
  async function begin(
    projectId: string,
    options: { mode: Mode | null; manual: boolean; trigger: RunRecord["trigger"]; notAfter?: number },
  ): Promise<{ record: RunRecord; done: Promise<RunRecord> }> {
    if (starting) throw new DreamError("A dream is starting; dreams run one at a time.");
    starting = true;
    try {
      return await beginOne(projectId, options);
    } finally {
      starting = false;
    }
  }

  async function failStart(state: ActiveState, error: string): Promise<never> {
    await finalize({ ...state, phase: "finishing", ended: { ok: false, summary: null, error } });
    throw new DreamError(`${state.record.projectName}: ${error}`);
  }

  async function beginOne(
    projectId: string,
    options: { mode: Mode | null; manual: boolean; trigger: RunRecord["trigger"]; notAfter?: number },
  ): Promise<{ record: RunRecord; done: Promise<RunRecord> }> {
    const active = await activeRecord();
    if (running !== null || active !== null) {
      throw new DreamError(`A dream is already running${active ? ` for ${active.projectName}` : ""}; dreams run one at a time.`);
    }
    if ((await ports.kv.get<number>(ORPHAN_KEY)) !== undefined) {
      throw new DreamError("A dream thread from an earlier run could not be confirmed stopped; no dream starts until it is.");
    }
    const closed = () => options.notAfter !== undefined && ports.now() >= options.notAfter;
    const config = await ports.config();
    const hostId = await dreamHost();
    const project = (await projectInputs(hostId)).find((candidate) => candidate.projectId === projectId);
    if (project === undefined) throw new DreamError(`Project ${projectId} has no checkout on the dream machine.`);
    if (closed()) throw new DreamError("The dream window closed before the dream could start.");

    const runId = newRunId();
    let state: ActiveState = {
      record: {
        runId,
        projectId,
        projectName: project.name,
        hostId,
        mode: options.mode ?? "dream",
        trigger: options.trigger,
        startedAt: ports.now(),
        endedAt: null,
        outcome: "running",
        threadId: null,
        changes: null,
        summary: null,
        backup: null,
        proposal: null,
        error: null,
      },
      phase: "preparing",
      canary: null,
      prompt: null,
      ended: null,
    };
    await saveActive(state);

    let prepared: Prepared;
    try {
      prepared = await ports.host.prepare(hostId, {
        runId,
        project,
        mode: options.mode,
        manual: options.manual,
        thresholds: config.thresholds,
        backupsToKeep: config.backupsToKeep,
      });
    } catch (error) {
      // The host may have taken the lock before the answer was lost; `finish` sorts that out.
      return failStart(state, `Could not prepare the dream: ${message(error)}`);
    }
    if (!prepared.ok) {
      await clearActive(runId);
      throw new DreamError(`${project.name}: ${prepared.reason}`);
    }
    state = {
      ...state,
      record: { ...state.record, mode: prepared.mode, backup: prepared.backup, proposal: prepared.proposal },
      phase: "spawning",
      canary: prepared.canary,
      prompt: renderPrompt(prepared),
    };
    await saveActive(state);
    if (closed()) return failStart(state, "The dream window closed while the dream was being prepared.");

    let threadId: string;
    try {
      threadId = await ports.threads.spawn({
        runId,
        projectId,
        projectName: project.name,
        hostId,
        workspace: prepared.workspace,
        prompt: canaryPrompt(prepared.canary),
        model: config.choices.model,
        reasoningLevel: config.choices.reasoningLevel,
      });
    } catch (error) {
      return failStart(state, `Could not start the dream thread: ${message(error)}`);
    }
    if (disposed) {
      // A newer copy of the plugin owns the run now and will end it; this thread must not run on.
      await stopAndConfirm(threadId, new AbortController().signal);
      throw new DreamError("bb reloaded the plugin while the dream thread was starting.");
    }
    state = { ...state, record: { ...state.record, threadId }, phase: "checking" };
    await saveActive(state);
    await history.put(state.record);
    const done = drive(state, lifetime.signal).finally(() => {
      running = null;
    });
    running = done;
    return { record: state.record, done };
  }

  /**
   * One tick of housekeeping: carries on the run in kv, if any; otherwise stops orphaned threads,
   * retries archives and ends host runs nobody watches.
   */
  async function recover(): Promise<void> {
    if (running !== null || starting) return;
    const state = await loadActive();
    if (state !== null) {
      running = drive(state, lifetime.signal).finally(() => {
        running = null;
      });
      await running;
      return;
    }
    try {
      await retryArchives();
      // A thread not confirmed stopped may still be writing: its lock must not be released under it.
      if (!(await stopOrphans(lifetime.signal))) return;
      const hostId = await dreamHost();
      const { runs } = await ports.host.activeRuns(hostId);
      for (const run of runs) {
        if (ports.now() - run.startedAt < MAX_DREAM_MS + START_GRACE_MS) continue;
        ports.log.warn(`Ending a dream the server lost track of (run ${run.runId}).`);
        await ports.host.finish(hostId, { runId: run.runId, ok: false, summary: null, threadId: null });
      }
    } catch (error) {
      ports.log.warn(`Could not tidy up after earlier dreams: ${message(error)}`);
    }
  }

  /**
   * One night's work: inside the window, the most overdue due project, one at a time, until none is
   * due or the window closes. A project is tried once per window, so a failing one cannot loop, and a
   * dream whose preparation runs past the window's end does not start.
   */
  async function sweep(signal: AbortSignal): Promise<number> {
    let dreams = 0;
    for (;;) {
      if (signal.aborted || disposed) break;
      const config = await ports.config();
      const closesAt = windowClosesAt(new Date(ports.now()), config.windowStart, config.windowEnd);
      if (!config.scheduleEnabled || closesAt === null) break;
      if (running !== null || (await loadActive()) !== null) break;
      const hostId = await dreamHost();
      const candidates = (await statuses(hostId)).filter((status) => dreamEligible(status) && !attempted.has(status.projectId));
      const pick = mostOverdue(candidates);
      if (pick === null) break;
      attempted.add(pick.projectId);
      try {
        const { done } = await begin(pick.projectId, { mode: null, manual: false, trigger: "schedule", notAfter: closesAt.getTime() });
        await done;
        dreams += 1;
      } catch (error) {
        ports.log.warn(`Dream for ${pick.name} did not start: ${message(error)}`);
      }
    }
    await ports.kv.set(LAST_SWEEP_KEY, ports.now());
    return dreams;
  }

  /** The background loop: every minute, carry on or tidy up (`recover`), then sweep when it is time. */
  async function loop(signal: AbortSignal): Promise<void> {
    let lastSweep: number | null = null;
    while (!signal.aborted && !disposed) {
      try {
        await recover();
        const config = await ports.config();
        const open = config.scheduleEnabled && inWindow(new Date(ports.now()), config.windowStart, config.windowEnd);
        if (!open) attempted = new Set();
        else if ((await loadActive()) === null && (lastSweep === null || ports.now() - lastSweep >= SWEEP_EVERY_MS)) {
          await sweep(signal);
          lastSweep = ports.now();
        }
      } catch (error) {
        ports.log.warn(`The dream sweep failed: ${message(error)}`);
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
      const active = await loadActive();
      if (active === null || active.record.threadId === null) return false;
      if (active.phase === "checking" || active.phase === "running") await ports.kv.set(STOP_KEY, active.record.runId);
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

    async proposal(projectId: string, stamp?: string): Promise<ProposalDiff> {
      const { hostId, project } = await checkoutOf(projectId);
      return ports.host.proposalDiff(hostId, { project, stamp });
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
