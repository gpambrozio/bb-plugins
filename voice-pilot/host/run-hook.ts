/**
 * Runs this machine's voice hook: the first of `HOOK_NAMES` in `~/.config/voice-pilot/` (`hook`, then
 * `hook.sh` and the others), never a command from anywhere else. Adapted from Herald's `host/run-hook.ts`: from the home folder, in a process group of its
 * own, and resolved on `exit`. Unlike Herald's, the whole group is killed as soon as the hook exits too, not
 * only at the time limit: a background process it started (`… &`) would otherwise outlive the limit, the
 * session and the worker. Its output is never read, and nothing here reads the file's contents (the editor's
 * `host/hook-file.ts` does, for the settings).
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { BB_SERVER_URL_ENV, HOOK_DIR, HOOK_EVENT_ENV, HOOK_FILE, HOOK_NAMES, HOOK_REASON_ENV, HOOK_TIMEOUT_MS, type HookEvent, type HookFileStatus, type HookRun } from "../shared/hooks";
import { RelayFinder } from "./relay";

/** This machine's hook file, in the home folder of the user the host daemon runs as. */
export function hookPath(home: string = homedir()): string {
  return join(home, ...HOOK_FILE.split("/"));
}

/** Whether `file` is there (a file, or a link to one) and can be run, and where it is. Reads nothing of it. */
export async function fileStatus(file: string): Promise<HookFileStatus> {
  try {
    if (!(await stat(file)).isFile()) return { present: false, executable: false, path: file };
  } catch {
    return { present: false, executable: false, path: file };
  }
  try {
    await access(file, constants.X_OK);
    return { present: true, executable: true, path: file };
  } catch {
    return { present: true, executable: false, path: file };
  }
}

/**
 * This machine's hook: the first of `HOOK_NAMES` that is a file in the hook folder, with the names of any
 * others there (which do not run). With none, `present` is false and `path` is where `hook` would be.
 */
export async function hookStatus(home: string = homedir()): Promise<HookFileStatus> {
  const found = (await Promise.all(HOOK_NAMES.map((name) => fileStatus(join(home, ...HOOK_DIR.split("/"), name))))).filter((status) => status.present);
  const [hook, ...rest] = found;
  if (hook === undefined) return { present: false, executable: false, path: hookPath(home) };
  return rest.length === 0 ? hook : { ...hook, others: rest.map((status) => status.path?.split("/").at(-1) ?? "") };
}

export interface RunHookOptions {
  /** The hook file; this machine's own (`hookStatus`) when absent. Tests name one. */
  file?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** bb's relay on this machine (`host/relay.ts`), set as `BB_SERVER_URL`; null or absent sets nothing. */
  bbServerUrl?: string | null;
}

/** Every hook still running in this worker, with how to kill its process group. */
const running = new Set<() => void>();
let exitGuard = false;

/** Kills every hook still running, with what it started; each run then resolves as ended by SIGKILL. */
export function killRunningHooks(): void {
  for (const kill of [...running]) kill();
}

/** A worker that exits must not leave a hook behind it; only a SIGKILL of the worker skips this. */
function guardExit(): void {
  if (exitGuard) return;
  exitGuard = true;
  process.once("exit", () => killRunningHooks());
}

/**
 * Runs the hook file for `event`, or answers null when there is none. The file is executed directly (its
 * `#!` line names what runs it), from the home folder, with `VOICE_PILOT_HOOK` set to `event` and
 * `VOICE_PILOT_REASON` to `reason` when there is one. Never rejects: a hook that cannot start (not
 * executable), fails or runs out of time is reported in the result. On Windows there is no process group, so
 * only the hook itself is stopped.
 */
export async function runHook(event: HookEvent, reason: string | null, options: RunHookOptions = {}): Promise<HookRun | null> {
  const status = options.file === undefined ? await hookStatus() : await fileStatus(options.file);
  if (!status.present || status.path === undefined) return null;
  const file = status.path;
  const timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
  const started = Date.now();
  const ownGroup = process.platform !== "win32";
  guardExit();
  return new Promise<HookRun>((resolve) => {
    let timedOut = false;
    let settled = false;
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), [HOOK_EVENT_ENV]: event };
    if (reason !== null) env[HOOK_REASON_ENV] = reason;
    else delete env[HOOK_REASON_ENV];
    const bbServerUrl = options.bbServerUrl ?? null;
    if (bbServerUrl !== null) env[BB_SERVER_URL_ENV] = bbServerUrl;
    const child = spawn(file, [], {
      cwd: options.cwd ?? homedir(),
      env,
      stdio: "ignore",
      detached: ownGroup,
      windowsHide: true,
    });
    /**
     * Kills the hook's process group, whether or not the hook itself is still running: what it started stays
     * in the group (unless it made a session of its own). Right after the hook exits the group id cannot have
     * been reused, since a member still holds it, or no process has it.
     */
    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        if (ownGroup) process.kill(-child.pid, "SIGKILL");
        else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // No process left in the group.
      }
    };
    running.add(kill);
    const finish = (exitCode: number | null, signal: string | null, failedToStart: boolean) => {
      if (settled) return;
      settled = true;
      // The hook has exited: anything it left running goes with it, now rather than at the time limit.
      kill();
      running.delete(kill);
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, failedToStart, durationMs: Date.now() - started, bbServerUrl, relayNote: null });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", () => finish(null, null, true));
    child.on("exit", (code, signal) => finish(code, signal, false));
  });
}

/** This worker's relay lookups: what a session's first hook found serves its later ones. */
const relay = new RelayFinder();

/**
 * Runs this machine's hook for `event` from the host entry: null when there is no hook file. A session's first
 * hook looks for bb's relay afresh, the others check what it found, and the hook gets `BB_SERVER_URL` when
 * there is one; when there is none, or the lookup fails or runs out of time, it runs exactly as without, and
 * the run says why.
 */
export async function runMachineHook(event: HookEvent, reason: string | null, finder: RelayFinder = relay): Promise<HookRun | null> {
  const hook = await hookStatus();
  if (!hook.present || hook.path === undefined) return null;
  const found = await finder.forRun(event === "listening-started");
  const run = await runHook(event, reason, { file: hook.path, bbServerUrl: found.url });
  return run === null ? null : { ...run, relayNote: found.note };
}
