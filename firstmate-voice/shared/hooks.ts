/**
 * The voice hooks: one command per bb machine, run on the machine whose bb desktop app holds the call, at six
 * moments of a session. One command handles them all: the moment is in `FIRSTMATE_VOICE_HOOK`, and why
 * listening stopped in `FIRSTMATE_VOICE_REASON`. Empty runs nothing, and empty is the default.
 *
 * Shared by the app, the server and the host entry, so it imports zod only, never the SDK.
 */
import { z } from "zod";

/**
 * In pairs: listening (the session), speaking (the voice), talking (the captain). Each "started" is followed
 * by its "stopped", and a session that ends closes the open pairs before `listening-stopped`.
 */
export const HOOK_EVENTS = [
  "listening-started",
  "listening-stopped",
  "speaking-started",
  "speaking-stopped",
  "talking-started",
  "talking-stopped",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const HookEventSchema = z.enum(HOOK_EVENTS);

/** The variable that names the moment, so one script handles all six. */
export const HOOK_EVENT_ENV = "FIRSTMATE_VOICE_HOOK";
/** Why listening stopped, on `listening-stopped` only ("ended by the captain", "quiet for ten minutes"…). */
export const HOOK_REASON_ENV = "FIRSTMATE_VOICE_REASON";

/** Long enough for any one-liner, or a path to a script; a whole script belongs in a file. */
export const HOOK_MAX_CHARS = 2000;

/** How long a command may run before it is stopped, with everything it started. */
export const HOOK_TIMEOUT_MS = 5_000;

export const HookCommandSchema = z.string().max(HOOK_MAX_CHARS);

/** Every machine's command, by bb host id. A machine with none is left out. */
export const VoiceHooksSchema = z.record(z.string().min(1), HookCommandSchema);
export type VoiceHooks = z.infer<typeof VoiceHooksSchema>;

/** The command to run on `hostId`, or null when it is empty: blank lines and spaces are empty too. */
export function hookCommand(hooks: VoiceHooks, hostId: string): string | null {
  const command = hooks[hostId]?.trim() ?? "";
  return command === "" ? null : command;
}

/** What the host entry reports of one run. Never its output: the command's output is ignored. */
export const HookRunSchema = z.object({
  exitCode: z.number().int().nullable(),
  /** The signal that ended it, when one did — a timeout's SIGKILL included. */
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  /** It could not be started at all (no shell, say). */
  failedToStart: z.boolean(),
  durationMs: z.number().int().min(0),
});
export type HookRun = z.infer<typeof HookRunSchema>;

/** One line on how a run went, for the debug log: "exit 0 after 120 ms", "stopped after 5 s"… */
export function hookOutcome(run: HookRun): string {
  if (run.failedToStart) return "could not be started";
  if (run.timedOut) return `stopped after ${Math.round(run.durationMs / 1000)} s, too slow`;
  if (run.signal !== null) return `ended by ${run.signal} after ${run.durationMs} ms`;
  return `exit ${run.exitCode ?? "?"} after ${run.durationMs} ms`;
}

export function hookFailed(run: HookRun): boolean {
  return run.failedToStart || run.timedOut || run.signal !== null || run.exitCode !== 0;
}
