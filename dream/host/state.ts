/**
 * Where the plugin keeps its files on the dream machine, all under the host data directory bb gives
 * the plugin (`~/.bb/plugins/dream/host-data/` on a default install), and `state.json`, the history
 * file: per project, whether its dreams edit in place yet, the threads and sessions that were its
 * dreams (never counted as sessions), and the last runs; and the runs in progress.
 *
 *     state.json
 *     guard.mjs                       the PreToolUse hook every dream runs under
 *     backups/<project id>/<stamp>.tar.gz
 *     proposals/<project id>/<stamp>/ a dry run: memory/, base.json, proposal.json
 *     runs/<run id>.log               the guard's decisions during one dream
 *
 * A dream thread's working directory is not here: bb refuses a thread workspace inside its own data
 * folder, so it is `<platform cache>/bb-dream/workspaces/<project id>/` (host/workspace-root.ts). The
 * copy of a project's code a dream reads is beside it, in `<platform cache>/bb-dream/code/<project id>/`
 * (host/code.ts).
 *
 * Folders are named by bb project id, which a rename does not change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DanglingLink } from "./links";
import type { Changes } from "./snapshot";

export interface DataPaths {
  root: string;
  state: string;
  guard: string;
  workspace(projectId: string): string;
  /** Where exports of the project's default branch go, one commit at a time. */
  code(projectId: string): string;
  backups(projectId: string): string;
  proposals(projectId: string): string;
  /** The guard's decision log for one run. */
  runLog(runId: string): string;
}

/** A project id as a folder name: bb's ids are already safe; anything else is made so. */
function folderOf(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * `workspacesRoot` is outside bb's data folder (see host/workspace-root.ts), and the code exports are
 * beside it; everything else is in `root`.
 */
export function dataPaths(root: string, workspacesRoot: string): DataPaths {
  return {
    root,
    state: path.join(root, "state.json"),
    guard: path.join(root, "guard.mjs"),
    workspace: (projectId) => path.join(workspacesRoot, folderOf(projectId)),
    code: (projectId) => path.join(path.dirname(workspacesRoot), "code", folderOf(projectId)),
    backups: (projectId) => path.join(root, "backups", folderOf(projectId)),
    proposals: (projectId) => path.join(root, "proposals", folderOf(projectId)),
    runLog: (runId) => path.join(root, "runs", `${folderOf(runId)}.log`),
  };
}

export interface RunHistoryEntry {
  runId: string;
  mode: "dream" | "dry-run";
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "changed" | "unchanged" | "proposed" | "failed";
  threadId: string | null;
  changes: Changes | null;
  backup: string | null;
  proposal: string | null;
  /** Links the dream left pointing at a memory file that is gone; missing in records before 0.1.0's link check. */
  danglingLinks?: DanglingLink[];
}

export interface ProjectState {
  name: string;
  /** False until a dry run's proposal has been applied: until then every scheduled dream is a dry run. */
  inPlace: boolean;
  dreamThreadIds: string[];
  dreamSessionIds: string[];
  history: RunHistoryEntry[];
}

export interface ActiveRun {
  runId: string;
  projectId: string;
  mode: "dream" | "dry-run";
  startedAt: number;
  /** The real memory folder, whose lock this run holds. */
  memoryDir: string;
  /** Where the dream writes: the memory folder, or a dry run's copy. */
  targetDir: string;
  workspace: string;
  priorMtime: number;
  /** The PID written into the lock, so a later host worker can still roll it back. */
  lockPid: number;
  /** Every name a `[[name]]` link could use for the memory when the run began, to tell which links it broke. */
  namesBefore?: string[];
  /** The startup check's verdict, decided once and never changed. */
  canaryVerdict?: { ok: boolean; reason: string } | null;
  backup: string | null;
  proposal: string | null;
}

export interface DreamState {
  version: 1;
  projects: Record<string, ProjectState>;
  runs: Record<string, ActiveRun>;
}

const KEEP_HISTORY = 50;
const KEEP_IDS = 500;

export function emptyState(): DreamState {
  return { version: 1, projects: {}, runs: {} };
}

export function readState(file: string): DreamState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DreamState>;
    return { version: 1, projects: parsed.projects ?? {}, runs: parsed.runs ?? {} };
  } catch {
    return emptyState();
  }
}

export function writeState(file: string, state: DreamState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}

export function projectState(state: DreamState, projectId: string, name: string): ProjectState {
  const existing = state.projects[projectId];
  if (existing) {
    existing.name = name;
    return existing;
  }
  const created: ProjectState = { name, inPlace: false, dreamThreadIds: [], dreamSessionIds: [], history: [] };
  state.projects[projectId] = created;
  return created;
}

function remember(list: string[], values: readonly string[]): void {
  for (const value of values) if (!list.includes(value)) list.push(value);
  if (list.length > KEEP_IDS) list.splice(0, list.length - KEEP_IDS);
}

export function rememberDreamThread(project: ProjectState, threadId: string): void {
  remember(project.dreamThreadIds, [threadId]);
}

export function rememberDreamSessions(project: ProjectState, sessionIds: readonly string[]): void {
  remember(project.dreamSessionIds, sessionIds);
}

export function recordHistory(project: ProjectState, entry: RunHistoryEntry): void {
  const index = project.history.findIndex((existing) => existing.runId === entry.runId);
  if (index >= 0) project.history[index] = entry;
  else project.history.unshift(entry);
  if (project.history.length > KEEP_HISTORY) project.history.length = KEEP_HISTORY;
}
