import { execFile } from "node:child_process";

import type { CommandFailure, RunCommand } from "./jobs";

/** How long a command has after SIGTERM before SIGKILL, and after SIGKILL before it is given up on. */
export const KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Runs a program with a hard upper bound on how long its caller waits.
 *
 * On its timeout, or when `signal` aborts, the child gets SIGTERM, then
 * SIGKILL after `graceMs`, and after another `graceMs` the promise rejects
 * whether or not the child's output has closed — a grandchild holding the pipe
 * open cannot keep it pending. So work holding the host's change lock always
 * lets go within `timeout + 2 × grace`. A signal that is already aborted
 * spawns nothing.
 */
export function createRunCommand(graceMs: number = KILL_GRACE_MS): RunCommand {
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(stopped(file, args, "was cancelled before it started"));
        return;
      }
      let settled = false;
      let why = "";
      const timers: ReturnType<typeof setTimeout>[] = [];
      function settle(): boolean {
        if (settled) return false;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      }
      const child = execFile(
        file,
        [...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: options?.env ?? process.env },
        (error, stdout, stderr) => {
          if (!settle()) return;
          if (error === null) {
            resolve({ stdout });
            return;
          }
          const failure = (why === "" ? error : stopped(file, args, why)) as CommandFailure;
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
        },
      );
      function stop(reason: string): void {
        if (settled || why !== "") return;
        why = reason;
        child.kill("SIGTERM");
        timers.push(
          setTimeout(() => {
            child.kill("SIGKILL");
            timers.push(
              setTimeout(() => {
                if (settle()) reject(stopped(file, args, `${reason} and did not exit`));
              }, graceMs),
            );
          }, graceMs),
        );
      }
      function onAbort(): void {
        stop("was cancelled");
      }
      timers.push(setTimeout(() => stop(`timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function stopped(file: string, args: readonly string[], why: string): CommandFailure {
  return new Error(`${file} ${args.join(" ")} ${why}`) as CommandFailure;
}
