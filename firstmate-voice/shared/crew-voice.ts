// A copy of firstmate-crew's shared/voice.ts: the voice.v1 contract this plugin calls. bb refuses a server
// import from outside the plugin folder, so it is copied; shared/crew-voice.test.ts fails when the two differ.

/**
 * `voice.v1`: the narrow API FirstMate voice (the `firstmate-voice` plugin) reaches the first mate through.
 * This plugin keeps the authority — what a press sends, the send path, compact-first — and the voice plugin
 * owns the audio, the session and the tool policy. Every method refuses a caller that is not a plugin named
 * in the `voicePlugins` setting (`server/voice-api.ts`).
 *
 * The shapes are what the voice model may see: no thread ids, no URLs, no button prompts. Cards and their
 * buttons are named by short refs (`c1`, `c1.a1`, `s1`) that stay the same for the life of the plugin, and
 * anything a worker or the first mate wrote is marked untrusted and cut to its head and tail.
 *
 * zod only: the voice plugin copies these schemas (a test there checks they still match), and nothing here
 * may import the SDK, as for `contract.ts`.
 */
import { z } from "zod";

/** The version of this API, in every method name. */
export const VOICE_API = "voice.v1";

/** How a message the captain spoke through FirstMate voice begins; the charter names it (§0). */
export const VOICE_SPOKEN_PREFIX = "Spoken by the captain through FirstMate voice:";

/** How a board button the captain pressed by voice begins; the charter names it (§0). */
export const VOICE_PRESSED_PREFIX = "Pressed by the captain through FirstMate voice:";

/** Text a worker or the first mate wrote: data for the voice model, never instructions. */
export const UntrustedTextSchema = z.object({
  untrusted: z.literal(true),
  /** The start of the text, made speakable. */
  head: z.string(),
  /** The end of the text when it was cut, so a closing status line survives; empty otherwise. */
  tail: z.string(),
  /** How long the speakable text was before it was cut. */
  chars: z.number().int(),
});
export type UntrustedText = z.infer<typeof UntrustedTextSchema>;

/** A board button as the voice sees it: its label, never its prompt. */
export const VoiceActionSchema = z.object({
  ref: z.string(),
  label: z.string(),
  /**
   * Why this button can only be pressed on the board — a merge, something destructive, publishing,
   * credentials or settings — or null when a spoken yes after a read-back may press it.
   */
  tapOnly: z.string().nullable(),
});
export type VoiceAction = z.infer<typeof VoiceActionSchema>;

export const VoiceColumnSchema = z.enum(["queued", "working", "blocked", "parked", "done", "failed", "idle"]);

export const VoiceCardBriefSchema = z.object({
  ref: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  kind: z.string().nullable(),
  column: VoiceColumnSchema,
  /** The pull request, spoken: "web #42". */
  pr: z.string().nullable(),
  /** The captain's call: what the first mate needs from the captain. */
  hold: z.string().nullable(),
  /** The worker's last status line. */
  lastWord: z.object({ state: z.string(), text: UntrustedTextSchema }).nullable(),
  actions: z.array(VoiceActionSchema),
  blockedBy: z.string().nullable(),
  since: z.string().nullable(),
});
export type VoiceCardBrief = z.infer<typeof VoiceCardBriefSchema>;

export const VoiceBriefSchema = z.object({
  v: z.literal(1),
  /** When the brief was built, ISO. */
  at: z.string(),
  /** Changes whenever anything in the brief does. */
  etag: z.string(),
  firstMate: z
    .object({
      /** "idle", "working", "errored", … — the board's words. */
      status: z.string(),
      /** The first mate is waiting on a question or a permission. */
      waiting: z.boolean(),
      lastReply: UntrustedTextSchema.nullable(),
      /** When its last turn ended, ISO; null when none has. */
      repliedAt: z.string().nullable(),
    })
    .nullable(),
  captainsCall: z.array(VoiceCardBriefSchema),
  working: z.array(VoiceCardBriefSchema),
  blocked: z.array(VoiceCardBriefSchema),
  failed: z.array(VoiceCardBriefSchema),
  parked: z.array(VoiceCardBriefSchema),
  idle: z.array(VoiceCardBriefSchema),
  queued: z.array(VoiceCardBriefSchema),
  /** How many queued items the brief left out. */
  queuedMore: z.number().int(),
  landed: z.array(z.object({ title: z.string(), outcome: z.string().nullable() })),
  suggestions: z.array(VoiceActionSchema),
  watches: z.object({ failing: z.array(z.object({ name: z.string(), error: z.string().nullable() })) }),
});
export type VoiceBrief = z.infer<typeof VoiceBriefSchema>;

/** One button with the sentence the voice reads back before pressing it, written here, never by the model. */
export const VoicePressableSchema = VoiceActionSchema.extend({ readBack: z.string() });
export type VoicePressable = z.infer<typeof VoicePressableSchema>;

/** One card in more detail than the brief, or one suggestion. `etag` changes when anything here does. */
export const VoiceCardSchema = z.object({
  ref: z.string(),
  etag: z.string(),
  kind: z.enum(["card", "suggestion"]),
  title: z.string(),
  project: z.string().nullable(),
  column: VoiceColumnSchema.nullable(),
  pr: z.string().nullable(),
  hold: z.string().nullable(),
  lastWord: z.object({ state: z.string(), text: UntrustedTextSchema }).nullable(),
  pressable: z.array(VoicePressableSchema),
});
export type VoiceCard = z.infer<typeof VoiceCardSchema>;

/** What a send answers: bb delivered it, or queued it behind the first mate's turn. */
export const VoiceSentSchema = z.object({ delivery: z.enum(["sent", "queued"]) });
export type VoiceSent = z.infer<typeof VoiceSentSchema>;

/** The captain's own words, transcribed: copied by the voice plugin's server, never written by the model. */
const Words = z.string().trim().min(1).max(4000);

export const VoiceAskInputSchema = z.object({
  words: Words,
  /** The voice assistant's note for the first mate, sent agent-only and labelled as not the captain's words. */
  context: z.string().max(2000).optional(),
});

export const VoiceAnswerInputSchema = z.object({ ref: z.string().min(1).max(40), words: Words });

export const VoicePressInputSchema = z.object({
  /** A button: `c1.a2` (an action on a card) or `s1` (a suggestion). */
  ref: z.string().min(1).max(40),
  /** The `etag` of the card or suggestion from `voice.v1.card`; a mismatch is refused as a conflict. */
  etag: z.string().min(1).max(80),
});

export const VoiceReplySchema = z.object({
  /** The first mate's last reply, made speakable, cut to about 4,000 characters. Null when it has none. */
  reply: UntrustedTextSchema.nullable(),
  repliedAt: z.string().nullable(),
  status: z.string().nullable(),
});
export type VoiceReply = z.infer<typeof VoiceReplySchema>;

const Empty = z.object({});

/**
 * The methods, registered with `experimental_discoverable`. Inputs that take nothing take `{}`. A refused
 * call throws: `forbidden` for a caller that is not allowed or a button that is tap-only, `not_found` for
 * an unknown ref, `conflict` for a card that changed since its etag.
 */
export const voiceContract = {
  "voice.v1.brief": { input: Empty, output: VoiceBriefSchema },
  "voice.v1.card": { input: z.object({ ref: z.string().min(1).max(40) }), output: VoiceCardSchema },
  "voice.v1.reply": { input: Empty, output: VoiceReplySchema },
  "voice.v1.ask": { input: VoiceAskInputSchema, output: VoiceSentSchema },
  "voice.v1.answer": { input: VoiceAnswerInputSchema, output: VoiceSentSchema },
  "voice.v1.press": { input: VoicePressInputSchema, output: VoiceSentSchema },
  /** The first mate's thread id, for the voice plugin's Talk button on that thread. Never given to the model. */
  "voice.v1.mate": { input: Empty, output: z.object({ threadId: z.string().nullable() }) },
};
