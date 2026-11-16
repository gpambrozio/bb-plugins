/**
 * Runs one voice hook on this machine. Adapted from Herald's `host/run-hook.ts`: through the machine's shell
 * from the home folder, the whole process group killed at the time limit, and resolved on `exit` so a
 * background process the command left behind cannot hold the call's hooks up. Its output is never read.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { HOOK_EVENT_ENV, HOOK_REASON_ENV, HOOK_TIMEOUT_MS, type HookEvent, type HookRun } from "../shared/hooks";

export interface RunHookOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
 * Runs `command` through `/bin/sh -c` (`cmd.exe` on Windows) with `FIRSTMATE_VOICE_HOOK` set to `event`, and
 * `FIRSTMATE_VOICE_REASON` to `reason` when there is one. Never rejects: a command that cannot start, fails
 * or runs out of time is reported in the result.
 */
export function runHook(event: HookEvent, reason: string | null, command: string, options: RunHookOptions = {}): Promise<HookRun> {
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
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd ?? homedir(),
      env,
      stdio: "ignore",
      detached: ownGroup,
      windowsHide: true,
    });
    const kill = (): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (ownGroup) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone between the check and the kill.
      }
    };
    running.add(kill);
    const finish = (exitCode: number | null, signal: string | null, failedToStart: boolean) => {
      if (settled) return;
      settled = true;
      running.delete(kill);
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, failedToStart, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", () => finish(null, null, true));
    child.on("exit", (code, signal) => finish(code, signal, false));
  });
}
