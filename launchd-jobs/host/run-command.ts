import { execFile } from "node:child_process";

import type { CommandFailure, RunCommand } from "./jobs";

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Runs a program with a timeout and a capped output buffer. A command that
 * outlives its timeout, or writes more than `maxBuffer`, is SIGKILLed — which
 * nothing can catch, so a stopped command never exits 0 and never counts as a
 * success — and `execFile` closes its pipes as it kills it, so a helper the
 * command left holding them does not keep the caller, or the change lock,
 * waiting. Once the timeout has passed the command fails whatever its exit
 * code: a child that exited 0 while a helper still held its output would
 * otherwise hand back that output cut short as a success.
 *
 * Nothing here cancels a command early: launchd runs the jobs, and the
 * commands this plugin runs (`launchctl`, `plutil`, the PATH probe) are short.
 */
export function createRunCommand(options: { maxBuffer?: number } = {}): RunCommand {
  const maxBuffer = options.maxBuffer ?? MAX_OUTPUT_BYTES;
  return (file, args, runOptions) =>
    new Promise((resolve, reject) => {
      const timeout = runOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // Set before `execFile`'s own timer, so it has always fired by the time that one closes the pipes.
      let expired = false;
      const deadline = setTimeout(() => {
        expired = true;
      }, timeout);
      execFile(
        file,
        [...args],
        {
          encoding: "utf8",
          timeout,
          killSignal: "SIGKILL",
          maxBuffer,
          env: runOptions?.env ?? process.env,
        },
        (error, stdout, stderr) => {
          clearTimeout(deadline);
          if (error === null && !expired) {
            resolve({ stdout });
            return;
          }
          const failure = error ?? new Error(`${file} ${args.join(" ")} timed out after ${timeout} ms`);
          reject(Object.assign(failure, { stdout, stderr }) as CommandFailure);
        },
      );
    });
}
