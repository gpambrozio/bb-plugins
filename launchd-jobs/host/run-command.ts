import { spawn } from "node:child_process";

import type { CommandFailure, RunCommand } from "./jobs";

/** How long a command has after SIGTERM before SIGKILL, and after SIGKILL before it is given up on. */
export const KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/**
 * Runs a program with a hard upper bound on how long its caller waits.
 *
 * The child starts in a process group of its own, so stopping it reaches
 * everything it started too — a login shell's helpers, say. On its timeout,
 * or when `signal` aborts, the group gets SIGTERM, then SIGKILL after
 * `graceMs`; after another `graceMs` the promise rejects and the output pipes
 * are destroyed, whether or not anything still holds them. So work holding the
 * host's change lock always lets go within `timeout + 2 × grace`, leaving
 * nothing behind. A command that was stopped never counts as a success, even
 * if it exits 0 on SIGTERM. A signal that is already aborted spawns nothing.
 */
export function createRunCommand(graceMs: number = KILL_GRACE_MS): RunCommand {
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (signal?.aborted) {
        reject(stopped(file, args, "was cancelled before it started", "", ""));
        return;
      }
      const child = spawn(file, [...args], {
        env: options?.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
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

      /** The whole group the child leads; a member that already exited is no error. */
      function signalGroup(name: NodeJS.Signals): void {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, name);
        } catch {
          // The group is gone already.
        }
      }

      function stop(reason: string): void {
        if (settled || why !== "") return;
        why = reason;
        signalGroup("SIGTERM");
        timers.push(
          setTimeout(() => {
            signalGroup("SIGKILL");
            timers.push(
              setTimeout(() => {
                if (!settle()) return;
                child.stdout.destroy();
                child.stderr.destroy();
                reject(stopped(file, args, `${reason} and did not exit`, stdout, stderr));
              }, graceMs),
            );
          }, graceMs),
        );
      }

      function onAbort(): void {
        stop("was cancelled");
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) stop("produced too much output");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > MAX_OUTPUT_CHARS) stop("produced too much output");
      });
      child.on("error", (error) => {
        if (!settle()) return;
        signalGroup("SIGKILL");
        const failure = error as CommandFailure;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      });
      child.on("close", (code, killedBy) => {
        if (!settle()) return;
        // Stopped is stopped: a child that exits 0 on SIGTERM still did not finish its work.
        if (why !== "") {
          reject(stopped(file, args, why, stdout, stderr));
          return;
        }
        if (code === 0) {
          resolve({ stdout });
          return;
        }
        const failure = new Error(
          `Command failed: ${file} ${args.join(" ")}${killedBy === null ? "" : ` (${killedBy})`}`,
        ) as CommandFailure;
        failure.code = code ?? undefined;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      });

      timers.push(setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function stopped(file: string, args: readonly string[], why: string, stdout: string, stderr: string): CommandFailure {
  const failure = new Error(`${file} ${args.join(" ")} ${why}`) as CommandFailure;
  failure.stdout = stdout;
  failure.stderr = stderr;
  return failure;
}
