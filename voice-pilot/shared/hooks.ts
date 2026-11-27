/**
 * The voice hooks: on each bb machine, one executable file in the owner's home folder
 * (`HOOK_FILE`), run on the machine whose bb desktop app holds the call, at six moments of a session. The
 * moment is in `VOICE_PILOT_HOOK`, and why listening stopped in `VOICE_PILOT_REASON`, so one script
 * handles them all. No file runs nothing, and there is none until the owner makes one.
 *
 * The command is never stored in bb nor set through it: bb names its app and its command line the same
 * caller, so anything a bb RPC or setting holds, an agent with `bb` could change. Only someone who can write
 * that file on that machine can choose what runs there. No RPC of this plugin reads the file or shows what is
 * in it; the settings page says whether it is there, and hands its path to bb's own file panel to open.
 *
 * Shared by the app, the server and the host entry, so it imports zod only, never the SDK.
 */
import { z } from "zod";

/**
 * In pairs: listening (the session), speaking (the voice), talking (the user). Each "started" is followed
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
export const HOOK_EVENT_ENV = "VOICE_PILOT_HOOK";
/** Why listening stopped, on `listening-stopped` only ("ended by the user", "quiet for ten minutes"…). */
export const HOOK_REASON_ENV = "VOICE_PILOT_REASON";
/** bb's relay on a machine joined through bb Connect, so the hook's `bb` reaches the server (bb internals). */
export const BB_SERVER_URL_ENV = "BB_SERVER_URL";
/** The longest reason a run gives for having no `BB_SERVER_URL`. */
export const RELAY_NOTE_MAX = 500;

/** The hook file, relative to the home folder of the machine it runs on. */
export const HOOK_FILE = ".config/voice-pilot/hook";
/** How the settings and the docs name it. */
export const HOOK_FILE_SHOWN = `~/${HOOK_FILE}`;

/** How long a run may take before it is stopped, with everything it started. */
export const HOOK_TIMEOUT_MS = 5_000;

/**
 * Whether a machine has a hook file; never what is in it. `path` is where it is (or would be) on that machine,
 * so the settings can hand it to bb's own file panel; a host entry older than 0.1.0's last change sends none.
 */
export const HookFileStatusSchema = z.object({ present: z.boolean(), executable: z.boolean(), path: z.string().min(1).max(1024).optional() });
export type HookFileStatus = z.infer<typeof HookFileStatusSchema>;

/** What the host entry reports of one run. Never its output: the hook's output is ignored. */
export const HookRunSchema = z.object({
  exitCode: z.number().int().nullable(),
  /** The signal that ended it, when one did — a timeout's SIGKILL included. */
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  /** It could not be started at all (not executable, say). */
  failedToStart: z.boolean(),
  durationMs: z.number().int().min(0),
  /** The `BB_SERVER_URL` the hook got: bb's relay on this machine, never a credential. Null when none was set. */
  bbServerUrl: z.string().max(100).nullable(),
  /** Why none was set, when none was. */
  relayNote: z.string().max(RELAY_NOTE_MAX).nullable(),
});
export type HookRun = z.infer<typeof HookRunSchema>;

/** One line on how a run went, for the debug log: "exit 0 after 120 ms", "stopped after 5 s"… */
export function hookOutcome(run: HookRun): string {
  if (run.failedToStart) return "could not be started";
  if (run.timedOut) return `stopped after ${Math.round(run.durationMs / 1000)} s, too slow`;
  if (run.signal !== null) return `ended by ${run.signal} after ${run.durationMs} ms`;
  return `exit ${run.exitCode ?? "?"} after ${run.durationMs} ms`;
}

/** One line on the hook's `BB_SERVER_URL`, for the debug log. */
export function relayLine(run: HookRun): string | null {
  if (run.bbServerUrl !== null) return `BB_SERVER_URL: ${run.bbServerUrl} (bb's relay on this machine; bb internals)`;
  if (run.relayNote !== null) return `No BB_SERVER_URL: ${run.relayNote}`;
  return null;
}

export function hookFailed(run: HookRun): boolean {
  return run.failedToStart || run.timedOut || run.signal !== null || run.exitCode !== 0;
}
