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
  /** Ends the run early: the worker is going away. */
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one speech hook through the machine's shell (`/bin/sh -c` on macOS and
 * Linux, `cmd.exe` on Windows) from the home folder, with `HERALD_HOOK` set to
 * its kind, and resolves when it exits. Never rejects: a command that cannot
 * start, fails or runs out of time is reported in the result.
 *
 * On a timeout the whole process group is killed, so a script that started
 * children does not leave them running. It resolves on `exit`, not `close`: a
 * background process the command left holding its error output must not keep
 * speech waiting.
 */
export function runHook(kind: SpeechHookKind, command: string, options: RunHookOptions = {}): Promise<HookRun> {
  const timeoutMs = options.timeoutMs ?? SPEECH_HOOK_TIMEOUT_MS;
  const started = Date.now();
  const ownGroup = process.platform !== "win32";
  return new Promise<HookRun>((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      child.stderr?.destroy();
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started, stderr: stderr.slice(-SPEECH_HOOK_STDERR_MAX) });
    };
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd ?? homedir(),
      env: { ...(options.env ?? process.env), [SPEECH_HOOK_ENV]: kind },
      stdio: ["ignore", "ignore", "pipe"],
      detached: ownGroup,
      windowsHide: true,
    });
    function kill(): void {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (ownGroup) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone between the check and the kill.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
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
