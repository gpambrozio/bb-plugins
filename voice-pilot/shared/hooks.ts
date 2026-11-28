/**
 * The voice hooks: on each bb machine, one executable file in the owner's home folder
 * (`HOOK_FILE`), run on the machine whose bb desktop app holds the call, at six moments of a session. The
 * moment is in `VOICE_PILOT_HOOK`, and why listening stopped in `VOICE_PILOT_REASON`, so one script
 * handles them all. No file runs nothing, and there is none until the owner makes one.
 *
 * The command is never stored in bb: it is the file on the machine. The settings' editor loads and saves that
 * file there by its name (one of `HOOK_NAMES`), never a path; bb names its app and its command line the same
 * caller, so an agent with `bb` can reach the editor's RPCs, as it can any file through `bb file write --host`.
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

/** The hook's folder, relative to the home folder of the machine it runs on. */
export const HOOK_DIR = ".config/voice-pilot";
/**
 * The names a hook file may have, in the order they are looked for: the first one there is the hook, and only
 * it runs. `hook` keeps its place first, so a machine set up before the others existed runs what it ran.
 * The others carry an extension bb's File Editor opens (bb 0.50.1 picks its editor by extension), so the
 * settings' Open the script edits them in bb; what runs them is still the file's own `#!` line.
 */
export const HOOK_NAMES = ["hook", "hook.sh", "hook.bash", "hook.zsh", "hook.fish", "hook.py", "hook.js", "hook.mjs", "hook.rb", "hook.pl"] as const;
/** The extension-less hook file, relative to the home folder. */
export const HOOK_FILE = `${HOOK_DIR}/hook`;
/** How the settings and the docs name it. */
export const HOOK_FILE_SHOWN = `~/${HOOK_FILE}`;
/** How the settings and the docs name the folder. */
export const HOOK_DIR_SHOWN = `~/${HOOK_DIR}/`;

/** `~/.config/voice-pilot/<name>` for a hook file's path (or name). */
export function hookShown(path: string): string {
  return `${HOOK_DIR_SHOWN}${path.split("/").at(-1) ?? path}`;
}

/** How long a run may take before it is stopped, with everything it started. */
export const HOOK_TIMEOUT_MS = 5_000;

/**
 * Whether a machine has a hook file; never what is in it. `path` is where it is (or would be) on that machine,
 * so the settings can hand it to bb's own file panel; a host entry older than 0.1.0's last change sends none.
 */
export const HookFileStatusSchema = z.object({
  present: z.boolean(),
  executable: z.boolean(),
  path: z.string().min(1).max(1024).optional(),
  /** The other hook files in the folder, by name: they do not run, since only the first one found does. */
  others: z.array(z.string().max(32)).max(HOOK_NAMES.length).optional(),
});
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

/** The largest hook file the settings' editor loads or saves. */
export const HOOK_EDIT_MAX = 256 * 1024;

export const HookNameSchema = z.enum(HOOK_NAMES);
export type HookName = z.infer<typeof HookNameSchema>;

/** The hook file that runs on a machine, as its editor loads it. */
export const HookFileReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: HookNameSchema, path: z.string().max(1024), content: z.string().max(HOOK_EDIT_MAX), sha256: z.string(), executable: z.boolean() }),
  /** No hook file there (any more). */
  z.object({ kind: z.literal("missing") }),
  /** One the editor does not load: too large, not text, or not readable. */
  z.object({ kind: z.literal("unsupported"), name: HookNameSchema, reason: z.string().max(300) }),
]);
export type HookFileRead = z.infer<typeof HookFileReadSchema>;

/** A save: the hook file by its name (never a path), its new text, and the hash of the text it was loaded as. */
export const HookWriteSchema = z.object({ name: HookNameSchema, content: z.string().max(HOOK_EDIT_MAX), expectedSha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
export type HookWrite = z.infer<typeof HookWriteSchema>;

export const HookWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), sha256: z.string(), executable: z.boolean() }),
  /** The file changed on disk since it was loaded (or is gone: `currentSha256` null); nothing was written. */
  z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
  /** The machine was reached, but the file could not be written there (permissions, a full disk…). */
  z.object({ outcome: z.literal("failed"), reason: z.string().max(300) }),
]);
export type HookWriteResult = z.infer<typeof HookWriteResultSchema>;
