import { spawn } from "node:child_process";
import { homedir } from "node:os";

import {
  SPEECH_HOOK_ENV,
  SPEECH_HOOK_STDERR_MAX,
  SPEECH_HOOK_TIMEOUT_MS,
  type HookRun,
  type SpeechHookKind,
} from "../shared/speech-hooks";

export interface RunHookOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Every hook still running in this worker, by kind, with how to kill its process group. */
const running = new Set<{ kind: SpeechHookKind; kill(): void }>();
let exitGuard = false;

/**
 * Kills the process group of every hook still running, or of every hook of
 * `kind`; each one's run then resolves as ended by SIGKILL.
 */
export function killRunningHooks(kind?: SpeechHookKind): void {
  for (const hook of [...running]) if (kind === undefined || hook.kind === kind) hook.kill();
}

/**
 * A hook's timeout lives in this worker, so a worker that exits must not leave
 * a hook behind it: bb's worker leaves through `process.exit` on every path it
 * controls — after `dispose`, and when `dispose` outlives bb's 5 s budget — and
 * `exit` listeners run then. Only a SIGKILL of the worker skips this.
 */
function guardExit(): void {
  if (exitGuard) return;
  exitGuard = true;
  process.once("exit", () => killRunningHooks());
}

/**
 * Runs one speech hook through the machine's shell (`/bin/sh -c` on macOS and
 * Linux, `cmd.exe` on Windows) from the home folder, with `HERALD_HOOK` set to
 * its kind, and resolves when it exits. Never rejects: a command that cannot
 * start, fails or runs out of time is reported in the result.
 *
 * On a timeout the whole process group is killed, so a script that started
 * children does not leave them running; `killRunningHooks` does the same from
 * outside, and so does the worker exiting. It resolves on `exit`, not `close`:
 * a background process the command left holding its error output must not
 * keep speech waiting.
 */
export function runHook(kind: SpeechHookKind, command: string, options: RunHookOptions = {}): Promise<HookRun> {
  const timeoutMs = options.timeoutMs ?? SPEECH_HOOK_TIMEOUT_MS;
  const started = Date.now();
  const ownGroup = process.platform !== "win32";
  guardExit();
  return new Promise<HookRun>((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd ?? homedir(),
      env: { ...(options.env ?? process.env), [SPEECH_HOOK_ENV]: kind },
      stdio: ["ignore", "ignore", "pipe"],
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
    const entry = { kind, kill };
    running.add(entry);
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      running.delete(entry);
      clearTimeout(timer);
      child.stderr?.destroy();
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started, stderr: stderr.slice(-SPEECH_HOOK_STDERR_MAX) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-SPEECH_HOOK_STDERR_MAX * 2);
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
  });
}
