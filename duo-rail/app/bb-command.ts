// Runs `bb <args…>` for a button: a plugin's command (`bb herald say …`) or one of bb's own.
//
// bb gives a plugin's app no call that runs a command-line command, plugin or not. What it does give is
// a terminal on any machine (`useSdk().terminals`), so the command runs in one on the bb server's
// machine, with the `bb` that bb installed there (Settings → General), and its last lines come back as
// a toast. The terminal is the SDK's, so it is closed when the command ends or after a minute.
//
// The terminal runs a POSIX `sh` wrapper in argv mode, so nothing is re-quoted by a shell: `$0` is the
// `bb` binary and `$@` the words. When the command ends the wrapper prints its exit status inside an
// OSC sequence terminals do not draw, then waits, so the output can be read before the terminal goes:
// bb drops an exited terminal, and a fast command would be gone before its output was read.
//
// The minute is kept on the server's machine, not by the page: the page can close or reload while a
// command runs (`bb plugin logs … -f` never ends), and the terminal outlives it. The wrapper starts the
// command as a process group of its own (job control, which the terminal's pty allows) and a watchdog
// in another group, which, at the deadline, prints a marker and kills the command's whole group, its
// children included. A hang-up (the terminal closed) or a TERM kills the group at once; the watchdog
// still fires if the wrapper itself was killed outright. The page reads with each request bounded,
// gives up a little after the deadline, and stops every run it has going when it unloads.
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

import { joinArgs } from "../shared/layout";

export const EXIT_MARKER = "\u001b]5253;duo-rail;exit;";
/** What the watchdog prints when the deadline passes, before it stops the command. */
export const TIMEOUT_MARKER = "\u001b]5253;duo-rail;timeout\u0007";
const BEL = "\u0007";

/** How long a command may run, kept by the watchdog on the server's machine. */
export const TIMEOUT_MS = 60_000;
/** How long past the deadline the page keeps reading, for the watchdog's report to arrive. */
export const CLIENT_GRACE_MS = 10_000;
/** The longest one output request may take before the page asks again (or gives up at its deadline). */
export const OUTPUT_WAIT_MS = 5_000;
const POLL_MS = 250;

/**
 * A `sh -c` script with `$0` the `bb` launcher and `$@` its arguments, run under a deadline, followed by
 * the exit marker and a wait. `set -m` gives the command and the watchdog process groups of their own
 * (killed whole with `kill -- -<group>`); turning it off again keeps bash from printing job notices into
 * the output. `sleep`, not `read`, at the end: a terminal nobody closes (the page went away) still ends,
 * two minutes later.
 */
export function wrap(script: string, deadlineSeconds = TIMEOUT_MS / 1000): string {
  return [
    "set -m",
    `( ${script} ) </dev/null &`,
    "job=$!",
    `( sleep ${deadlineSeconds}; printf '\\033]5253;duo-rail;timeout\\007'; kill -TERM -"$job" 2>/dev/null; sleep 3; kill -KILL -"$job" 2>/dev/null ) </dev/null &`,
    "dog=$!",
    "set +m",
    `trap 'kill -TERM -"$job" 2>/dev/null; kill -TERM -"$dog" 2>/dev/null; sleep 1; kill -KILL -"$job" 2>/dev/null; exit 129' HUP INT TERM`,
    // dash reports a job killed by a signal ("Terminated") on the shell's stderr; the command's own
    // stderr is untouched.
    'wait "$job" 2>/dev/null',
    "status=$?",
    'kill -TERM -"$dog" 2>/dev/null',
    `printf '\\033]5253;duo-rail;exit;%d\\007' "$status"`,
    "sleep 120",
  ].join("\n");
}
/** A button's command: `bb` with the words as they are. */
export const WRAPPER = wrap(`"$0" "$@"`);
const SUMMARY_LINES = 6;
const SUMMARY_CHARS = 600;

export type BbCommandResult =
  | { outcome: "finished"; exitCode: number; output: string }
  | { outcome: "timed-out"; output: string }
  /** The page went away (or Duo Rail reloaded) first; the terminal was closed, which stops the command. */
  | { outcome: "cancelled"; output: string }
  | { outcome: "unavailable"; reason: string };

type Sdk = Pick<PluginBrowserBbSdk, "system" | "terminals">;

export interface RunOptions {
  /** Waits `ms`; an aborted `signal` may end the wait early (the default clears its timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** The runs this page has going, so they can all be stopped when it unloads. */
const running = new Set<AbortController>();

/** Stops every command this page is running and closes its terminal: the page is going away. */
export function cancelBbRuns(): void {
  for (const run of running) run.abort();
}

const TOO_SLOW = Symbol("too slow");
const CANCELLED = Symbol("cancelled");

/** `promise`, unless `ms` pass or the run is cancelled first. */
async function within<T>(promise: Promise<T>, ms: number, sleep: NonNullable<RunOptions["sleep"]>, run: AbortSignal): Promise<T | typeof TOO_SLOW | typeof CANCELLED> {
  const timer = new AbortController();
  let onAbort = () => {};
  const cancelled = new Promise<typeof CANCELLED>((resolve) => {
    onAbort = () => resolve(CANCELLED);
    if (run.aborted) onAbort();
    run.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled, sleep(ms, timer.signal).then((): typeof TOO_SLOW => TOO_SLOW)]);
  } finally {
    // One read or wait per poll: leave no listener behind on the run, and no timer.
    run.removeEventListener("abort", onAbort);
    timer.abort();
  }
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The exit status the wrapper printed, or null while the command still runs. */
export function exitStatus(text: string): number | null {
  const start = text.lastIndexOf(EXIT_MARKER);
  if (start < 0) return null;
  const end = text.indexOf(BEL, start);
  if (end < 0) return null;
  const code = Number(text.slice(start + EXIT_MARKER.length, end));
  return Number.isInteger(code) ? code : null;
}

/** Terminal output as plain text: escape sequences out (colours, the marker), carriage returns folded. */
export function plainText(text: string): string {
  return (
    text
      // OSC … BEL or ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // CSI sequences
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // anything else after ESC
      .replace(/\u001b[@-_]/g, "")
      .split("\n")
      // a carriage return redraws the line: keep what was drawn last
      .map((line) => line.replace(/\r$/, "").split("\r").at(-1) ?? "")
      .join("\n")
  );
}

/** The last few lines worth showing in a toast. */
export function summarize(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = lines.slice(-SUMMARY_LINES).join("\n");
  return tail.length > SUMMARY_CHARS ? `…${tail.slice(-SUMMARY_CHARS)}` : tail;
}

export function runBbCommand(sdk: Sdk, args: readonly string[], options: RunOptions = {}): Promise<BbCommandResult> {
  return runBbScript(sdk, `"$0" "$@"`, args, { title: `bb ${joinArgs(args)}`, ...options });
}

/**
 * Runs a `sh` script on the server's machine, `$0` being bb's launcher and `$@` the arguments, and
 * returns everything it printed once it ends.
 */
export async function runBbScript(sdk: Sdk, script: string, args: readonly string[], options: RunOptions & { title: string }): Promise<BbCommandResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const cli = await sdk.system.experimental_cliCommand();
  if (!cli.supported || cli.installedPath === null) {
    return { outcome: "unavailable", reason: "bb's command-line tool is not installed on the bb server's machine. Install it in bb's Settings → General." };
  }
  const { primaryHostId } = await sdk.system.config();
  if (primaryHostId === null) return { outcome: "unavailable", reason: "bb has no machine to run the command on." };

  const terminal = await sdk.terminals.create({
    cols: 120,
    rows: 40,
    title: options.title,
    scope: { kind: "host_path", hostId: primaryHostId, cwd: null },
    start: { mode: "argv", argv: ["/bin/sh", "-c", wrap(script), cli.installedPath, ...args] },
  });
  const decoder = new TextDecoder();
  let text = "";
  let sinceSeq: number | undefined;
  // The watchdog on the server keeps the minute; this is only how long the page waits to hear of it.
  const deadline = now() + TIMEOUT_MS + CLIENT_GRACE_MS;
  const output = () => plainText(text.slice(0, text.lastIndexOf(EXIT_MARKER) >= 0 ? text.lastIndexOf(EXIT_MARKER) : text.length));
  const run = new AbortController();
  running.add(run);
  try {
    for (;;) {
      if (run.signal.aborted) return { outcome: "cancelled", output: output() };
      const wait = Math.max(0, Math.min(OUTPUT_WAIT_MS, deadline - now()));
      const page = await within(sdk.terminals.output({ terminalId: terminal.id, ...(sinceSeq === undefined ? {} : { sinceSeq }) }), wait, sleep, run.signal);
      if (page === CANCELLED) return { outcome: "cancelled", output: output() };
      if (page !== TOO_SLOW) {
        for (const chunk of page.chunks) text += decoder.decode(decodeBase64(chunk.dataBase64), { stream: true });
        sinceSeq = page.nextSeq;
        const status = exitStatus(text);
        const ended = status !== null || page.status === "exited" || page.status === "disconnected";
        // The watchdog stopped it at the deadline.
        if (ended && text.includes(TIMEOUT_MARKER)) return { outcome: "timed-out", output: output() };
        if (status !== null) return { outcome: "finished", exitCode: status, output: output() };
        // The wrapper itself ended (killed, or a shell that could not start).
        if (ended) return { outcome: "finished", exitCode: page.exitCode ?? 1, output: output() };
      }
      if (now() >= deadline) return { outcome: "timed-out", output: output() };
      if ((await within(sleep(POLL_MS), POLL_MS, sleep, run.signal)) === CANCELLED) return { outcome: "cancelled", output: output() };
    }
  } finally {
    running.delete(run);
    // Closing the terminal hangs up on the wrapper, which stops the command's group. If the close does
    // not get out (the page is unloading), the watchdog still stops it at the deadline.
    await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch((error: unknown) => console.warn("duo-rail: could not close the command's terminal", error));
  }
}
