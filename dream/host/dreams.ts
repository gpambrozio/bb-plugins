/**
 * Everything the dream machine does for the plugin, over its own files. Built with its machine's
 * facts injected (home, environment, data folder, PID), so tests run it against temporary folders.
 *
 * Changes run one at a time (`exclusive`): taking a lock, a backup, a copy, applying or restoring.
 * Reads (`scan`, `status`, `backups`) do not wait.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { evaluateGate, type Thresholds } from "../shared/gate";
import type { Finished, ManifestEntry, MemoryInfo, Mode, Prepared, ProjectInput, ProjectStatus } from "../shared/types";
import { acquireLock, lockState, markConsolidated, processIsAlive, rollbackLock, type AcquireOptions, type IsAlive } from "./lock";
import { codeSource } from "./code";
import { danglingLinks, memoryNames, type DanglingLink } from "./links";
import { claudeConfigDir, hookBlockers, resolveMemory, type MemoryEnvironment, type ResolvedMemory } from "./memory";
import { applyProposal, createProposal, describeProposal, discardProposal, findProposal, finishProposal, listProposals, pendingProposal, planApply, type Proposal } from "./proposals";
import { projectSlug } from "./slug";
import { backup, changeCount, diffManifests, listBackups, manifest, newestChange, pruneBackups, restoreBackup, stampOf, type Changes, type Manifest } from "./snapshot";
import {
  dataPaths,
  projectState,
  readState,
  recordHistory,
  rememberDreamSessions,
  rememberDreamThread,
  writeState,
  type ActiveRun,
  type DataPaths,
  type DreamState,
} from "./state";
import { checkoutFolders, checkoutSlugs, listSessions, listTranscriptFolders, parseWorktreeFolder, sessionTitle, type SessionFile, type WorktreeFolder } from "./transcripts";
import { armPolicy, CANARY_FILE, STARTUP_MEMORY, writeWorkspace } from "./workspace";
import { bbDataRoot, insideBbData } from "./workspace-root";

/** The most sessions a dream's prompt lists; the rest are counted. */
export const MAX_LISTED_SESSIONS = 300;
/** Longer than any dream (45 minutes) plus the server's grace for a lost run. */
const LEASE_LIMIT_MS = 2 * 3_600_000;
const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

export interface DreamsOptions {
  dataDir: string;
  home: string;
  env: MemoryEnvironment;
  managedDirs: readonly string[];
  platform: string;
  pid: number;
  nodePath: string;
  electron: boolean;
  guardSource: string;
  isAlive?: IsAlive;
  now?: () => number;
  /** Where dream workspaces go; outside bb's data folder, which refuses them. */
  workspacesRoot: string;
  /** For tests: how long a new lock settles before it is read back, and how to wait. */
  lockSettle?: Pick<AcquireOptions, "settleMs" | "sleep">;
}

/** Keeps the host worker alive while a dream runs; answers its release. Called inside `prepare`. */
export type Retain = () => () => void;

export class DreamRefusal extends Error {
  constructor(readonly code: Extract<Prepared, { ok: false }>["code"], message: string) {
    super(message);
  }
}

interface ActiveRunRecord extends ActiveRun {
  before: Manifest;
  /** The guard's decision log for this run, and the canary file the startup check asks for. */
  logPath: string;
  canary: string;
}

export interface CanaryResult {
  ok: boolean;
  reason: string;
}

function emptyChanges(): Changes {
  return { added: [], changed: [], deleted: [] };
}

function realOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function indexFacts(dir: string): { indexLines: number | null; indexBytes: number | null } {
  try {
    const text = readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    const lines = text.split("\n");
    return { indexLines: lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, indexBytes: Buffer.byteLength(text) };
  } catch {
    return { indexLines: null, indexBytes: null };
  }
}

/** The startup check's verdict from its evidence: the guard's log and the canary file. */
function canaryVerdict(run: ActiveRunRecord): CanaryResult {
  let logged = false;
  try {
    logged = readFileSync(run.logPath, "utf8")
      .split("\n")
      .some((line) => {
        try {
          return (JSON.parse(line) as { canary?: unknown }).canary === true;
        } catch {
          return false;
        }
      });
  } catch {
    logged = false;
  }
  // The evidence stays until the run is finished, so nothing can turn a failed check into a pass.
  const written = existsSync(run.canary);
  if (!logged && written) return { ok: false, reason: "the check file was written and the guard never saw it: the workspace's hooks did not run" };
  if (!logged) return { ok: false, reason: "the guard never saw the check's Write (hooks off, or the thread did not try it)" };
  if (written) return { ok: false, reason: "the check file was written although its hook failed: this Claude Code ignores onFailure: \"block\"" };
  return { ok: true, reason: "the guard ran and a failing hook blocked the call" };
}

export function createDreams(options: DreamsOptions) {
  // Real paths throughout, so the hook command and the transcript folder's name are spelled one way.
  mkdirSync(options.dataDir, { recursive: true });
  const paths: DataPaths = dataPaths(realOrSelf(options.dataDir), options.workspacesRoot);
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
  const projectsDir = path.join(claudeConfigDir(options.home, options.env), "projects");
  const leases = new Map<string, () => void>();
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  /** A backup name not yet taken: two backups in the same millisecond would otherwise share one. */
  function freshBackupStamp(projectId: string): string {
    const taken = new Set(listBackups(paths.backups(projectId)).map((entry) => entry.stamp));
    let at = now();
    while (taken.has(stampOf(at))) at += 1;
    return stampOf(at);
  }

  function load(): DreamState {
    return readState(paths.state);
  }

  /**
   * Liveness as this plugin sees a lock: a lock holding this worker's own PID with no dream of ours
   * in progress on that folder is a dream that finished, not one running, so the plugin may take it.
   * Every other process still sees the PID alive for the lock's hour, as native auto-dream expects.
   */
  function aliveFor(memoryDir: string, state: DreamState = load()): IsAlive {
    const real = realOrSelf(memoryDir);
    const ours = Object.values(state.runs).some((run) => run.memoryDir === real);
    return (pid) => (pid === options.pid && !ours ? false : isAlive(pid));
  }

  function takeLock(memoryDir: string, state?: DreamState): Promise<number | null> {
    return acquireLock(memoryDir, options.pid, { isAlive: aliveFor(memoryDir, state), now: now(), ...options.lockSettle });
  }

  function save(state: DreamState): void {
    writeState(paths.state, state);
  }

  function memoryOf(project: ProjectInput): ResolvedMemory {
    return resolveMemory({ checkout: project.checkout, home: options.home, env: options.env, managedDirs: options.managedDirs });
  }

  function memoryInfo(memory: ResolvedMemory): MemoryInfo {
    const files = manifest(memory.dir);
    return { ...memory, files: Object.keys(files).length, ...indexFacts(memory.dir) };
  }

  /** The project's transcript folders and sessions, its dreams' own left out. */
  function sessionsOf(project: ProjectInput, folders: readonly string[], state: DreamState): { folders: string[]; sessions: SessionFile[] } {
    const own = state.projects[project.projectId];
    const dreamThreads = new Set(own?.dreamThreadIds ?? []);
    const dreamSessions = new Set(own?.dreamSessionIds ?? []);
    const present = new Set(folders);
    const mine = new Set([
      ...checkoutFolders(folders, checkoutSlugs(project.checkout, realOrSelf(project.checkout))),
      ...project.worktreeFolders.filter((name) => present.has(name)),
    ]);
    const kept = [...mine].filter((name) => {
      const parsed = parseWorktreeFolder(name);
      return parsed === null || !dreamThreads.has(parsed.threadId);
    });
    const sessions = kept.flatMap((name) => listSessions(projectsDir, name)).filter((session) => !dreamSessions.has(session.sessionId));
    return { folders: kept.sort(), sessions };
  }

  /**
   * The last dream: the lock's mtime (this plugin's dreams and native ones), or the one this plugin
   * recorded if the lock has since been removed; 0 when there was none. Never the memory's newest file.
   */
  function lastDreamOf(lockMtime: number, state: DreamState, projectId: string): number {
    return Math.max(lockMtime, state.projects[projectId]?.lastDreamAt ?? 0);
  }

  function evaluate(project: ProjectInput, folders: readonly string[], state: DreamState, thresholds: Thresholds, enabled: boolean) {
    const memory = memoryOf(project);
    const info = memoryInfo(memory);
    const { folders: own, sessions } = sessionsOf(project, folders, state);
    const lock = lockState(memory.dir, aliveFor(memory.dir, state), now());
    const pending = pendingProposal(paths.proposals(project.projectId));
    const checkoutExists = existsSync(project.checkout);
    const gate = checkoutExists
      ? evaluateGate({
          now: now(),
          enabled,
          thresholds,
          memory: { mdCount: info.files, newestChangeMs: info.files > 0 ? newestChange(memory.dir) : null, autoMemoryEnabled: memory.autoMemoryEnabled },
          lock: { lastConsolidatedAt: lastDreamOf(lock.lastConsolidatedAt, state, project.projectId), held: lock.held || Object.values(state.runs).some((run) => run.projectId === project.projectId) },
          sessions,
          pendingProposal: pending?.stamp ?? null,
        })
      : null;
    return { memory, info, folders: own, sessions, lock, pending, gate };
  }

  function proposalSummary(proposal: Proposal | null) {
    if (proposal === null) return null;
    return { stamp: proposal.stamp, createdAt: proposal.createdAt, status: proposal.status, changes: proposal.changes, dir: proposal.dir };
  }

  return {
    paths,
    projectsDir,

    scan(): { projectsDir: string; platform: string; worktreeFolders: WorktreeFolder[] } {
      const worktreeFolders = listTranscriptFolders(projectsDir)
        .map(parseWorktreeFolder)
        .filter((folder): folder is WorktreeFolder => folder !== null);
      return { projectsDir, platform: options.platform, worktreeFolders };
    },

    status(projects: readonly ProjectInput[], thresholds: Thresholds): ProjectStatus[] {
      const folders = listTranscriptFolders(projectsDir);
      const state = load();
      return projects.map((project) => {
        const result = evaluate(project, folders, state, thresholds, project.enabled);
        const gate = result.gate ?? {
          due: false,
          code: "no-checkout" as const,
          reason: `Its checkout ${project.checkout} is not on this machine.`,
          lastDreamAt: lastDreamOf(result.lock.lastConsolidatedAt, state, project.projectId) || null,
          sessionsSince: 0,
          daysSince: 0,
        };
        const backups = listBackups(paths.backups(project.projectId));
        return {
          projectId: project.projectId,
          name: project.name,
          checkout: project.checkout,
          enabled: project.enabled,
          memory: result.info,
          gate: {
            due: gate.due,
            code: gate.code,
            reason: gate.reason,
            lastDreamAt: gate.lastDreamAt,
            sessionsSince: gate.sessionsSince,
            daysSince: gate.daysSince,
          },
          folders: result.folders.length,
          sessions: result.sessions.length,
          inPlace: state.projects[project.projectId]?.inPlace ?? false,
          pendingProposal: proposalSummary(result.pending),
          lastBackup: backups[0]?.stamp ?? null,
        };
      });
    },

    prepare(
      input: { runId: string; project: ProjectInput; mode: Mode | null; manual: boolean; thresholds: Thresholds; backupsToKeep: number },
      retain?: Retain,
    ): Promise<Prepared> {
      return exclusive(async () => {
        const { project } = input;
        const state = load();
        const own = projectState(state, project.projectId, project.name);
        const result = evaluate(project, listTranscriptFolders(projectsDir), state, input.thresholds, true);
        const refuse = (code: Extract<Prepared, { ok: false }>["code"], reason: string): Prepared => ({ ok: false, code, reason });
        if (result.gate === null) return refuse("no-checkout", `The checkout ${project.checkout} is not on this machine.`);
        if (result.info.files === 0) return refuse("no-memory", `${result.memory.dir} has no .md files.`);
        if (result.pending !== null) {
          return refuse("proposal-pending", `A dry run from ${result.pending.stamp} waits: apply it with \`bb dream apply\` or discard it with \`bb dream discard\` first.`);
        }
        if (!input.manual && !result.gate.due) return refuse(result.gate.code, result.gate.reason);
        if (result.gate.code === "locked") return refuse("locked", result.gate.reason);
        const blockers = hookBlockers({ home: options.home, env: options.env, managedDirs: options.managedDirs });
        if (blockers.length > 0) {
          return refuse("no-guard", `Dream's guard hook would not run, so no dream may start: ${blockers.join("; ")}.`);
        }

        if (insideBbData(bbDataRoot(options.dataDir), paths.workspace(project.projectId))) {
          return refuse("no-workspace", `bb refuses a thread workspace inside its own data folder, and ${paths.workspace(project.projectId)} is there.`);
        }

        const memoryDir = realOrSelf(result.memory.dir);
        const mode: Mode = input.mode ?? (own.inPlace ? "dream" : "dry-run");
        const priorMtime = await takeLock(memoryDir, state);
        if (priorMtime === null) return refuse("locked", "Another dream holds its memory lock.");
        const startedAt = now();
        const stamp = stampOf(startedAt);
        try {
          let backupStamp: string | null = null;
          let proposalStamp: string | null = null;
          let targetDir = memoryDir;
          if (mode === "dream") {
            backupStamp = freshBackupStamp(project.projectId);
            await backup(memoryDir, paths.backups(project.projectId), backupStamp);
            pruneBackups(paths.backups(project.projectId), input.backupsToKeep);
          } else {
            // A dry run's folder is named by its start; two in the same millisecond must not share one.
            let at = startedAt;
            while (existsSync(path.join(paths.proposals(project.projectId), stampOf(at)))) at += 1;
            const proposal = createProposal(memoryDir, paths.proposals(project.projectId), stampOf(at), startedAt);
            proposalStamp = proposal.stamp;
            targetDir = realOrSelf(proposal.memoryDir);
          }
          // The code the dream checks memories against: the newest default-branch commit the
          // repository has, which the checkout may be months behind. Reads the repository only.
          const code = await codeSource({ checkout: project.checkout, projectCodeDir: paths.code(project.projectId) });
          const logPath = paths.runLog(input.runId);
          mkdirSync(path.dirname(logPath), { recursive: true });
          rmSync(logPath, { force: true });
          const workspace = realOrSelf(
            writeWorkspace(
              { dir: paths.workspace(project.projectId), memoryDir: targetDir, logPath, guardPath: paths.guard, nodePath: options.nodePath, electron: options.electron },
              options.guardSource,
            ),
          );
          // What the session will really load at start, resolved as Claude Code does: an environment or
          // managed `autoMemoryDirectory` beats the workspace's own, and would put the memory in front of
          // the agent before its guard is proven. Refuse rather than start.
          const startup = path.join(workspace, STARTUP_MEMORY);
          const effective = resolveMemory({ checkout: workspace, home: options.home, env: options.env, managedDirs: options.managedDirs });
          if (realOrSelf(effective.dir) !== realOrSelf(startup)) {
            rollbackLock(memoryDir, priorMtime, options.pid);
            return refuse(
              "no-guard",
              `A dream session here would load ${effective.dir} as its memory (from ${effective.source === "env" ? "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE" : effective.source}), not its own empty folder, so the memory would reach the agent before its guard is proven. No dream may start while that is set.`,
            );
          }

          const since = result.gate.since;
          const listed: ManifestEntry[] = [];
          for (const session of since.slice(0, MAX_LISTED_SESSIONS)) {
            const file = path.join(projectsDir, session.folder, `${session.sessionId}.jsonl`);
            const found = result.sessions.find((candidate) => candidate.sessionId === session.sessionId);
            listed.push({ path: file, date: new Date(session.mtimeMs).toISOString().slice(0, 16).replace("T", " "), title: await sessionTitle(file), size: found?.size ?? 0 });
          }
          const sinceFolders = [...new Set(since.map((session) => path.join(projectsDir, session.folder)))].sort();

          const run: ActiveRunRecord = {
            runId: input.runId,
            projectId: project.projectId,
            mode,
            startedAt,
            memoryDir,
            targetDir,
            workspace,
            priorMtime,
            lockPid: options.pid,
            namesBefore: memoryNames(memoryDir),
            canaryVerdict: null,
            backup: backupStamp,
            proposal: proposalStamp,
            before: manifest(targetDir),
            logPath,
            canary: path.join(workspace, CANARY_FILE),
          };
          state.runs[input.runId] = run;
          recordHistory(own, { runId: input.runId, mode, startedAt, endedAt: null, outcome: "running", threadId: null, changes: null, backup: backupStamp, proposal: proposalStamp });
          save(state);
          if (retain) {
            const release = retain();
            // A run whose `finish` never comes (the server lost it) must not keep the worker for ever.
            const timer = setTimeout(() => {
              release();
              leases.delete(input.runId);
            }, LEASE_LIMIT_MS);
            timer.unref?.();
            leases.set(input.runId, () => {
              clearTimeout(timer);
              release();
            });
          }

          return {
            ok: true,
            mode,
            workspace,
            targetDir,
            memoryDir,
            checkout: project.checkout,
            code,
            transcriptFolders: sinceFolders,
            sessions: listed,
            sessionCount: since.length,
            // From the code the dream reads, so they are as current as it; a file only the checkout
            // has (CLAUDE.local.md is never committed) from the checkout.
            instructionFiles: INSTRUCTION_FILES.map((file) => [code.dir, project.checkout].map((dir) => path.join(dir, file)).find((candidate) => existsSync(candidate))).filter(
              (file): file is string => file !== undefined,
            ),
            backup: backupStamp,
            proposal: proposalStamp,
            canary: path.join(workspace, CANARY_FILE),
          };
        } catch (error) {
          rollbackLock(memoryDir, priorMtime, options.pid);
          throw error;
        }
      });
    },

    /**
     * The startup check, after the thread's first turn asked it to Write the canary file: proven only
     * when the guard logged that Write (so it ran) and the file does not exist (so the companion hook's
     * failure blocked it, which needs `onFailure: "block"`). The verdict is kept with the run and the
     * file stays until `finish`, so asking again never turns a failure into a pass. A pass arms the
     * guard: only then may it allow writes in the dream's real target.
     */
    checkCanary(runId: string): Promise<CanaryResult> {
      return exclusive(() => {
        const state = load();
        const run = state.runs[runId] as ActiveRunRecord | undefined;
        if (run === undefined) return { ok: false, reason: `No dream ${runId} is in progress on this machine.` };
        // Decided once: a repeat, after a reload or from a second copy, answers the same.
        // A pass is only answered with the policy armed: armed before the verdict is stored, and again
        // on every repeat, so a crash or failed write between the two cannot leave a pass unarmed.
        if (run.canaryVerdict) {
          if (run.canaryVerdict.ok) armPolicy(run.workspace, run.targetDir);
          return run.canaryVerdict;
        }
        const verdict = canaryVerdict(run);
        if (verdict.ok) armPolicy(run.workspace, run.targetDir);
        run.canaryVerdict = verdict;
        save(state);
        return verdict;
      });
    },

    /**
     * Ends a prepared run. Safe to repeat: a run already finished answers what it recorded then
     * (`found: true`), and an unknown one `found: false`, so a lost answer can be asked for again.
     */
    finish(input: { runId: string; ok: boolean; summary: string | null; threadId: string | null }): Promise<Finished> {
      return exclusive(() => {
        const state = load();
        const run = state.runs[input.runId] as ActiveRunRecord | undefined;
        if (run === undefined) {
          for (const project of Object.values(state.projects)) {
            const entry = project.history.find((candidate) => candidate.runId === input.runId && candidate.endedAt !== null);
            if (entry) {
              const proposed = entry.outcome === "proposed";
              return {
                found: true,
                mode: entry.mode,
                changes: entry.changes ?? emptyChanges(),
                backup: entry.backup,
                proposal: proposed ? entry.proposal : null,
                proposalDir: null,
                warning: null,
                danglingLinks: entry.danglingLinks ?? [],
              };
            }
          }
          return { found: false, mode: "dream", changes: emptyChanges(), backup: null, proposal: null, proposalDir: null, warning: null, danglingLinks: [] };
        }
        const own = projectState(state, run.projectId, state.projects[run.projectId]?.name ?? run.projectId);
        if (input.threadId) rememberDreamThread(own, input.threadId);
        rememberDreamSessions(own, listSessions(projectsDir, projectSlug(run.workspace)).map((session) => session.sessionId));

        rmSync(run.canary, { force: true });
        // The lock was taken by the worker that prepared the run, which may have been replaced since.
        const owner = run.lockPid ?? options.pid;
        let rollbackFailed = false;
        const rollback = () => {
          if (!rollbackLock(run.memoryDir, run.priorMtime, owner)) rollbackFailed = true;
        };
        let changes: Changes = emptyChanges();
        let proposalDir: string | null = null;
        let resultDir = run.targetDir;
        let outcome: "changed" | "unchanged" | "proposed" | "failed";
        if (run.mode === "dry-run" && run.proposal !== null) {
          const proposal = findProposal(paths.proposals(run.projectId), run.proposal);
          if (proposal === null) throw new Error(`The dry run ${run.proposal} has lost its folder.`);
          const finished = finishProposal(proposal, input.ok, input.summary);
          changes = finished.changes ?? emptyChanges();
          proposalDir = finished.dir;
          resultDir = finished.memoryDir;
          if (!input.ok) {
            outcome = "failed";
            rollback();
          } else if (changeCount(changes) === 0) {
            // Nothing to propose. A dry run never counts as a dream, so the lock goes back too.
            outcome = "unchanged";
            discardProposal(finished);
            rollback();
          } else {
            // Not consolidated until applied; `apply` moves the lock to the dry run's start.
            outcome = "proposed";
            rollback();
          }
        } else {
          changes = diffManifests(run.before, manifest(run.targetDir));
          if (input.ok) outcome = changeCount(changes) > 0 ? "changed" : "unchanged";
          else {
            outcome = "failed";
            rollback();
          }
        }

        // A dream that deleted or renamed a memory must not leave links to it behind: flag any it left.
        const links: DanglingLink[] = outcome === "changed" || outcome === "proposed" ? danglingLinks(resultDir, run.namesBefore ?? []) : [];

        // A real dream that ended well is one, whatever it changed; a dry run counts only when applied.
        if (run.mode === "dream" && outcome !== "failed") own.lastDreamAt = Math.max(own.lastDreamAt ?? 0, run.startedAt);
        delete state.runs[input.runId];
        recordHistory(own, {
          runId: run.runId,
          mode: run.mode,
          startedAt: run.startedAt,
          endedAt: now(),
          outcome,
          threadId: input.threadId,
          changes,
          backup: run.backup,
          proposal: run.proposal,
          danglingLinks: links,
        });
        save(state);
        leases.get(input.runId)?.();
        leases.delete(input.runId);
        return {
          found: true,
          mode: run.mode,
          changes,
          backup: run.backup,
          proposal: outcome === "proposed" ? run.proposal : null,
          proposalDir: outcome === "proposed" ? proposalDir : null,
          warning: rollbackFailed
            ? `The memory lock could not be set back to the last dream's time: another process holds it now. The project may wait for its next dream as if this run had happened.`
            : null,
          danglingLinks: links,
        };
      });
    },

    apply(project: ProjectInput, stamp: string | undefined, backupsToKeep: number) {
      return exclusive(async () => {
        const memoryDir = realOrSelf(memoryOf(project).dir);
        const proposal = findProposal(paths.proposals(project.projectId), stamp);
        if (proposal === null) throw new DreamRefusal("proposal-pending", stamp ? `No dry run ${stamp} for ${project.name}.` : `${project.name} has no dry run waiting.`);
        const changes = planApply(proposal, memoryDir);
        const priorMtime = await takeLock(memoryDir);
        if (priorMtime === null) throw new DreamRefusal("locked", "Another dream holds its memory lock.");
        try {
          const backupStamp = freshBackupStamp(project.projectId);
          await backup(memoryDir, paths.backups(project.projectId), backupStamp);
          pruneBackups(paths.backups(project.projectId), backupsToKeep);
          applyProposal(proposal, memoryDir, changes, now());
          markConsolidated(memoryDir, proposal.createdAt, options.pid);
          const state = load();
          const own = projectState(state, project.projectId, project.name);
          own.inPlace = true;
          own.lastDreamAt = Math.max(own.lastDreamAt ?? 0, proposal.createdAt);
          save(state);
          return { stamp: proposal.stamp, changes, backup: backupStamp };
        } catch (error) {
          rollbackLock(memoryDir, priorMtime, options.pid);
          throw error;
        }
      });
    },

    discard(project: ProjectInput, stamp: string | undefined) {
      return exclusive(async () => {
        const proposal = findProposal(paths.proposals(project.projectId), stamp);
        if (proposal === null || proposal.status !== "ready") {
          throw new DreamRefusal("proposal-pending", stamp ? `No dry run ${stamp} waits for ${project.name}.` : `${project.name} has no dry run waiting.`);
        }
        // A discarded dry run never counts as a dream: the memory and its lock are left exactly as
        // they are, so the next dream is given every session since the last real one.
        discardProposal(proposal);
        return { stamp: proposal.stamp };
      });
    },

    restore(project: ProjectInput, stamp: string | undefined, backupsToKeep: number) {
      return exclusive(async () => {
        const memoryDir = realOrSelf(memoryOf(project).dir);
        const backups = listBackups(paths.backups(project.projectId));
        const chosen = stamp === undefined ? backups[0] : backups.find((entry) => entry.stamp === stamp || entry.stamp.startsWith(stamp));
        if (chosen === undefined) throw new DreamRefusal("no-memory", stamp ? `No backup ${stamp} for ${project.name}.` : `${project.name} has no backups.`);
        const priorMtime = await takeLock(memoryDir);
        if (priorMtime === null) throw new DreamRefusal("locked", "Another dream holds its memory lock.");
        try {
          const before = freshBackupStamp(project.projectId);
          await backup(memoryDir, paths.backups(project.projectId), before);
          const changes = await restoreBackup(chosen.file, memoryDir);
          pruneBackups(paths.backups(project.projectId), backupsToKeep + 1);
          return { stamp: chosen.stamp, changes, backup: before };
        } finally {
          // A restore is not a dream: the last-dream time stays what it was.
          rollbackLock(memoryDir, priorMtime, options.pid);
        }
      });
    },

    /** The waiting dry run's changes, file by file, against the memory as it is now. Reads only. */
    proposalDiff(project: ProjectInput, stamp: string | undefined) {
      const proposal = findProposal(paths.proposals(project.projectId), stamp);
      if (proposal === null || proposal.status !== "ready") {
        throw new DreamRefusal("proposal-pending", stamp ? `No dry run ${stamp} waits for ${project.name}.` : `${project.name} has no dry run waiting.`);
      }
      const memoryDir = realOrSelf(memoryOf(project).dir);
      return { ...describeProposal(proposal, memoryDir), danglingLinks: danglingLinks(proposal.memoryDir, memoryNames(memoryDir)) };
    },

    backups(project: ProjectInput) {
      return {
        backups: listBackups(paths.backups(project.projectId)).map((entry) => ({ stamp: entry.stamp, size: entry.size })),
        proposals: listProposals(paths.proposals(project.projectId)).map((proposal) => proposalSummary(proposal) as NonNullable<ReturnType<typeof proposalSummary>>),
      };
    },

    /** Every project's waiting dry run, from the proposal folders alone: no memory or transcript is read. */
    waiting() {
      const state = load();
      const root = path.join(paths.root, "proposals");
      let folders: string[];
      try {
        folders = readdirSync(root);
      } catch {
        return [];
      }
      return folders.flatMap((folder) => {
        const proposal = pendingProposal(path.join(root, folder));
        if (proposal === null) return [];
        return [{ projectId: folder, projectName: state.projects[folder]?.name ?? folder, stamp: proposal.stamp, createdAt: proposal.createdAt }];
      });
    },

    activeRuns() {
      return Object.values(load().runs).map((run) => ({ runId: run.runId, projectId: run.projectId, startedAt: run.startedAt }));
    },

    dispose() {
      for (const release of leases.values()) release();
      leases.clear();
    },
  };
}

export type Dreams = ReturnType<typeof createDreams>;

