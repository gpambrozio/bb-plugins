/**
 * What both halves agree on: one "needs you" entry, the stored voices, and the
 * realtime channel.
 *
 * The app imports this module at run time, so it must never import the SDK
 * root (`@get-bb/plugin-sdk`) — a git install builds the app bundle without it.
 * The RPC contract, which does, lives in `shared/contract.ts` and the app
 * imports that one as a type only.
 */
import { z } from "zod";

/**
 * Why a thread is waiting. The first three come from a pending interaction —
 * bb's `user_question`, an approval of a `plan`, and every other approval — and
 * the last two from how a turn ended.
 */
export const ATTENTION_REASONS = ["question", "plan", "permission", "finished", "error"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];
export const AttentionReasonSchema = z.enum(ATTENTION_REASONS);

/**
 * The entry's sentence. `ready` is announced; `pending` is being written by a
 * model and becomes `ready` with its sentence, or with the plain `fallback`
 * when that fails; `off` is listed but never spoken — the event kind is
 * switched off, or the thread is a subagent its parent speaks for.
 */
export const SummaryStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), text: z.string() }),
  z.object({ status: z.literal("pending"), fallback: z.string() }),
  z.object({ status: z.literal("off"), fallback: z.string() }),
]);
export type SummaryState = z.infer<typeof SummaryStateSchema>;

export const AttentionEntrySchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  /** The project's name, which names the work when the thread has no title. */
  projectName: z.string().nullable(),
  /** The thread's title, or bb's generated fallback title; null while unnamed. */
  threadTitle: z.string().nullable(),
  /**
   * The start of what the user last asked this thread, for telling two threads
   * with similar titles apart. Null for a pause, which needs no history.
   */
  lastRequest: z.string().nullable(),
  /** The last part of the thread's working directory, when bb knows it. */
  folder: z.string().nullable(),
  reason: AttentionReasonSchema,
  /** Unique per event, so a client can remember what it has already spoken. */
  eventId: z.string(),
  /** The pending interaction this entry answers to, when it is one. */
  requestId: z.string().nullable(),
  createdAt: z.string(),
  /** One line: the question, the command, "Finished". */
  headline: z.string(),
  /** The choices, the command, or the start of the final message. */
  detail: z.string().nullable(),
  summary: SummaryStateSchema,
});
export type AttentionEntry = z.infer<typeof AttentionEntrySchema>;

/**
 * What is said for an entry, or null when it is never spoken. Never longer
 * than the server will render, whatever an older entry stored.
 */
export function speechText(entry: AttentionEntry): string | null {
  return entry.summary.status === "ready" ? clipSpeech(entry.summary.text) : null;
}

function clipSpeech(text: string): string {
  return text.length <= MAX_SPEECH_CHARS ? text : `${text.slice(0, MAX_SPEECH_CHARS - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Realtime

/**
 * The server publishes here whenever the store changes. The payload is only a
 * nudge: clients re-read the list, which is what liveness filters, and re-read
 * it again on reconnect because a realtime signal is never replayed.
 */
export const ENTRIES_CHANNEL = "entries";

/**
 * Published when the stored configuration changes on the server — the custom
 * command seeded after a settings change — so an open settings page re-reads it.
 */
export const CONFIG_CHANNEL = "config";

// ---------------------------------------------------------------------------
// Speech rendered on the server

export const SpeechVoiceSchema = z.object({ name: z.string(), lang: z.string() });
export type SpeechVoice = z.infer<typeof SpeechVoiceSchema>;

export const MAX_SPEECH_CHARS = 2000;

/** Speech rates, as a multiplier on the voice's own pace; strings because they are picked from a list. */
export const RATE_OPTIONS = ["0.8", "1", "1.2", "1.5"] as const;

/**
 * Where the voice comes from. `say` has the bb server's Mac render the sentence
 * with its own voices and the app play the audio; `web` is the browser's own
 * speech synthesis, which every web client has but which sounds worse. `say`
 * falls back to `web` when the server is not a Mac or the render fails.
 */
export const SPEECH_ENGINES = ["say", "web"] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

// ---------------------------------------------------------------------------
// Stored configuration

/**
 * The voices, by name. Lists of voices run to hundreds and do not fit a
 * host-rendered select, so these are picked in the settings section.
 * Empty means the platform's default voice.
 */
export const VoicesConfigSchema = z.object({
  say: z.string(),
  web: z.string(),
});
export type VoicesConfig = z.infer<typeof VoicesConfigSchema>;

export const DEFAULT_VOICES: VoicesConfig = { say: "", web: "" };

/**
 * The command that writes the sentence when the tool is `custom`. Kept here
 * rather than in the host form because the form cannot show a field only for
 * one choice of another; Herald's settings section shows it when it applies.
 */
export const StoredConfigSchema = z.object({
  voices: VoicesConfigSchema,
  sentenceCommand: z.string(),
});
export type StoredConfig = z.infer<typeof StoredConfigSchema>;

export const DEFAULT_STORED_CONFIG: StoredConfig = {
  voices: { ...DEFAULT_VOICES },
  sentenceCommand: "",
};
