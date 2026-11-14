/**
 * The speech hooks: a command the owner sets per machine, run on the machine
 * whose bb desktop app is about to speak ("before") and once it has finished
 * ("after"). Empty runs nothing, and empty is the default.
 *
 * Speech is tracked on that machine as runs: a window opens one before its
 * first sentence and ends it after its last, and the machine's host entry
 * runs "before" when the first open run starts and "after" when the last one
 * ends — whichever window or reason ended it (`host/sessions.ts`).
 *
 * Shared by the three halves — the app, the server and the host entry — so it
 * imports zod only, never the SDK (see `shared/herald.ts`).
 */
import { z } from "zod";

export const SPEECH_HOOK_KINDS = ["before", "after"] as const;
export type SpeechHookKind = (typeof SPEECH_HOOK_KINDS)[number];
export const SpeechHookKindSchema = z.enum(SPEECH_HOOK_KINDS);

/** Long enough for any one-liner, or a path to a script; a whole script belongs in a file. */
export const SPEECH_HOOK_MAX_CHARS = 2000;

/**
 * How long a hook may run before it is stopped and speech goes on without it.
 * The client stops waiting a little later, in case the host never answers.
 */
export const SPEECH_HOOK_TIMEOUT_MS = 5_000;

/**
 * How long a run of speech stays open on its machine without word from the
 * window speaking it. The window renews it every `SPEECH_HOOK_RENEW_MS` while
 * it speaks; a window that closes, reloads or loses the server stops renewing,
 * and the machine runs the after hook itself once the lease runs out.
 */
export const SPEECH_HOOK_LEASE_MS = 30_000;
export const SPEECH_HOOK_RENEW_MS = 10_000;

/** How much of a failed hook's error output is kept for the log. */
export const SPEECH_HOOK_STDERR_MAX = 1_000;

/** The environment variable a hook reads to tell "before" from "after", for one script that does both. */
export const SPEECH_HOOK_ENV = "HERALD_HOOK";

export const SpeechHookCommandSchema = z.string().max(SPEECH_HOOK_MAX_CHARS);

export const MachineHooksSchema = z.object({
  before: SpeechHookCommandSchema,
  after: SpeechHookCommandSchema,
});
export type MachineHooks = z.infer<typeof MachineHooksSchema>;

export const NO_HOOKS: MachineHooks = { before: "", after: "" };

/** Every machine's hooks, by bb host id. A machine with none is left out. */
export const SpeechHooksSchema = z.record(z.string().min(1), MachineHooksSchema);
export type SpeechHooks = z.infer<typeof SpeechHooksSchema>;

/** The command to run, or null when the setting is empty: blank lines and spaces are empty too. */
export function hookCommand(hooks: SpeechHooks, hostId: string, kind: SpeechHookKind): string | null {
  const command = hooks[hostId]?.[kind].trim() ?? "";
  return command === "" ? null : command;
}

/** A run of speech, named by the window that opens it. */
export const RunIdSchema = z.string().min(1).max(100);

/** What the host entry reports of one run of a command. */
export const HookRunSchema = z.object({
  exitCode: z.number().int().nullable(),
  /** The signal that ended it, when one did — a timeout's SIGKILL included. */
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  /** The end of its error output, at most `SPEECH_HOOK_STDERR_MAX` characters. */
  stderr: z.string(),
});
export type HookRun = z.infer<typeof HookRunSchema>;

/** Why a run failed, for the log; null when it succeeded. */
export function hookFailure(run: HookRun): string | null {
  if (run.timedOut) return `it was stopped after ${SPEECH_HOOK_TIMEOUT_MS / 1000} seconds`;
  if (run.signal !== null) return `it was ended by ${run.signal}`;
  if (run.exitCode !== 0) {
    const output = run.stderr.trim();
    return `it exited with ${run.exitCode ?? "no code"}${output === "" ? "" : `: ${output}`}`;
  }
  return null;
}
