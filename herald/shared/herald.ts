/**
 * What both halves agree on: one "needs you" entry, the summariser's stored
 * configuration, the realtime channel, and the prompt template's vocabulary.
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
 * The summary's lifecycle. `pending` while the helper thread is writing;
 * `ready` with its sentence; `failed` with the reason and a deterministic
 * fallback built from the raw event; `off` when no summary was written at all
 * — the event kind is switched off, the thread is a subagent its parent speaks
 * for, or the user moved on before the queued summary reached the front —
 * recorded so the panel can still say something, but never spoken.
 */
export const SummaryStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("ready"), text: z.string(), model: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string(), fallback: z.string() }),
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
  /** One line built without a model: the question, the command, "Finished". */
  headline: z.string(),
  /** The choices, the command, or the start of the final message. */
  detail: z.string().nullable(),
  summary: SummaryStateSchema,
});
export type AttentionEntry = z.infer<typeof AttentionEntrySchema>;

/**
 * What is said for an entry, or null when there is nothing to say yet or ever.
 * Never longer than the server will render, whatever an older entry stored.
 */
export function speechText(entry: AttentionEntry): string | null {
  switch (entry.summary.status) {
    case "ready":
      return clipSpeech(entry.summary.text);
    case "failed":
      return clipSpeech(entry.summary.fallback);
    case "pending":
    case "off":
      return null;
  }
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
// The summariser's stored configuration

/** The event kinds a user can switch off, one setting each. */
export const ANNOUNCE_KEYS = ["question", "plan", "permission", "finished", "error"] as const satisfies readonly AttentionReason[];

/**
 * What a prompt template may put in `{{ }}`, and what each is filled with. The
 * descriptions are what the settings section lists, so they are written for
 * the person editing the prompt.
 *
 * Two rules the editor states and `renderPrompt` keeps: a **line** whose
 * placeholder has nothing to fill it for this event is left out whole — that
 * is how "Detail: {{detail}}" disappears for an event with no detail — and a
 * name that is not on this list is left in the prompt exactly as typed.
 */
export const PROMPT_PLACEHOLDERS = [
  { name: "thread", description: "What the work is called: the thread's title, or its project's name." },
  { name: "project", description: "The project's name, or the folder name when bb has none." },
  { name: "folder", description: "The last part of the thread's working directory." },
  { name: "event", description: "A sentence saying why the thread is waiting — a question, a plan, a finished turn." },
  { name: "headline", description: "The one line Herald builds without a model: the question, the command, \"Finished\"." },
  { name: "detail", description: "The choices, the command, or the start of the final message. Often empty." },
  { name: "request", description: "What the user last asked this thread for. Empty when the thread paused without one." },
  { name: "output", description: "What the agent said at the end of its turn. Empty for a pause." },
] as const;
export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number]["name"];

/**
 * The prompt every summary starts from, and what *Restore the default* puts
 * back. The closing line is what makes the helper answer with
 * `{"speech": "..."}`; a template without it still works — the parser falls
 * back to reading the reply as prose — but the sentence is less predictable.
 */
export const DEFAULT_SUMMARY_PROMPT = [
  // One line per paragraph: the editor wraps them, and a break typed here is a
  // break the reader has to tidy up before editing the sentence it lands in.
  "You are Herald. You tell a developer, out loud, what one of their coding agents needs. Answer with the JSON object only. Do not run tools, read files, or ask anything back.",
  "",
  'Thread: "{{thread}}", in the project "{{project}}" (folder {{folder}}).',
  "Event: {{event}}",
  "Headline: {{headline}}",
  "Detail: {{detail}}",
  "",
  "What the user last asked for: {{request}}",
  "",
  "What the agent said: {{output}}",
  "",
  "Write what should be spoken: one or two sentences, under 35 words, plain text with no markdown, no code, and no file paths unless nothing else identifies the work. Start with the thread's name as given above, so the listener knows which piece of work this is about. For a question, say what is being asked and the choices. For finished work, say what was done and whether anything is left for the user. For a permission, say what the agent wants to do.",
  "",
  'Reply with exactly one JSON object shaped like {"speech": "..."} — the key must be "speech", no code fences, nothing before or after it.',
].join("\n");

/** The reasoning levels bb accepts, the same list the model picker offers. */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;

/**
 * Who writes the summaries and from what. Edited in the plugin's settings
 * section — the model picker and the prompt editor do not fit the host-rendered
 * form — and kept in the plugin's own storage.
 *
 * A blank prompt is not an error: it means "the default prompt", and the editor
 * saves blank when the draft matches it, so a user who never customised the
 * prompt follows the default as it changes.
 */
export const SummarizerConfigSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.enum(REASONING_LEVELS),
  prompt: z.string(),
});
export type SummarizerConfig = z.infer<typeof SummarizerConfigSchema>;

export const DEFAULT_SUMMARIZER: SummarizerConfig = {
  providerId: "claude-code",
  model: "claude-haiku-4-5-20251001",
  reasoningLevel: "low",
  prompt: "",
};

/**
 * The voices, by name. Lists of voices run to hundreds and do not fit a
 * host-rendered select, so these are picked in the settings section too.
 * Empty means the platform's default voice.
 */
export const VoicesConfigSchema = z.object({
  say: z.string(),
  web: z.string(),
});
export type VoicesConfig = z.infer<typeof VoicesConfigSchema>;

export const DEFAULT_VOICES: VoicesConfig = { say: "", web: "" };

export const StoredConfigSchema = z.object({
  summarizer: SummarizerConfigSchema,
  voices: VoicesConfigSchema,
});
export type StoredConfig = z.infer<typeof StoredConfigSchema>;

export const DEFAULT_STORED_CONFIG: StoredConfig = {
  summarizer: { ...DEFAULT_SUMMARIZER },
  voices: { ...DEFAULT_VOICES },
};
