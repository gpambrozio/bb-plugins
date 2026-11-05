/**
 * What the server and the app share: the shapes of offers, sessions and exercises as the app sees
 * them, and the values a card submits. Plain zod and constants, no SDK import, so the app bundle can
 * import it at run time (see the root AGENTS.md, *Dependencies*).
 */
import { z } from "zod";

import { AnswerFormSchema, FormValuesSchema } from "./answer-form";

/** This plugin's id; threads it starts carry it as `originPluginId`. */
export const PLUGIN_ID = "learning-exercises";

/**
 * A thread's workspace, for turning file references in Markdown into links that open the file in bb:
 * relative paths resolve against `rootPath`, the workspace's absolute folder on its machine. Null where
 * the thread has no workspace or it is gone (an archived thread's).
 */
export const WorkspaceSchema = z.object({ threadId: z.string(), environmentId: z.string(), rootPath: z.string() });
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** What made the plugin offer an exercise. Ordered from most to least worth offering. */
export const TRIGGER_KINDS = ["pr-merged", "commit", "schema", "new-files", "streak", "manual"] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const TRIGGER_LABELS: Record<TriggerKind, string> = {
  "pr-merged": "pull request merged",
  commit: "commit",
  schema: "schema change",
  "new-files": "new files",
  streak: "working streak",
  manual: "started by you",
};

/** What the plugin points at for a trigger: the commits, paths or pull request the topic came from. */
export const RefsSchema = z.object({
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })).optional(),
  paths: z.array(z.string()).optional(),
  prUrl: z.string().optional(),
});
export type Refs = z.infer<typeof RefsSchema>;

export const OFFER_ANSWERS = ["start", "here", "later", "not-thread", "never-project"] as const;
export const OfferAnswerSchema = z.enum(OFFER_ANSWERS);
export type OfferAnswer = z.infer<typeof OfferAnswerSchema>;

export const OfferSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  trigger: TriggerKindSchema,
  topic: z.string(),
  refs: RefsSchema,
  createdAt: z.number(),
  seenAt: z.number().nullable(),
});
export type Offer = z.infer<typeof OfferSchema>;

/** Where a session runs: its own thread forked from the work, or the work thread itself. */
export const SessionModeSchema = z.enum(["fork", "here"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SESSION_STATES = ["starting", "active", "awaiting-answer", "paused", "finished", "abandoned"] as const;
export const SessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** Why a session is paused, in words the tab can show as they are. */
export const PAUSE_REASONS = {
  user: "you paused it",
  timeout: "the question waited 30 minutes",
  restart: "bb restarted or the plugin reloaded while a question was open",
  archived: "its thread was archived",
  stopped: "its thread was stopped",
  interrupted: "the question could not be shown or was interrupted",
} as const;
export type PauseReason = keyof typeof PAUSE_REASONS;

export const EXERCISE_TYPES = ["prediction", "generation", "trace", "debug", "teach-back", "retrieval", "other"] as const;
export const ExerciseTypeSchema = z.enum(EXERCISE_TYPES);
export type ExerciseType = z.infer<typeof ExerciseTypeSchema>;

export const VERDICTS = ["correct", "partly", "incorrect", "skipped"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ExerciseSchema = z.object({
  ordinal: z.number(),
  type: ExerciseTypeSchema,
  question: z.string(),
  files: z.array(z.string()),
  askedAt: z.number(),
  answer: z.string().nullable(),
  confidence: z.number().nullable(),
  skipped: z.boolean(),
  stuck: z.number(),
  answeredAt: z.number().nullable(),
  verdict: VerdictSchema.nullable(),
  gap: z.string().nullable(),
  /** The answer form the question was asked with; null for a plain text answer. */
  form: AnswerFormSchema.nullable(),
  /** The learner's answer by field id when it came from a form; `answer` then holds its summary. */
  fields: FormValuesSchema.nullable(),
  /**
   * What the agent wrote in the thread after the learner answered (or skipped) and before the next
   * question: its feedback. Read from the thread's event log, since bb folds a turn's earlier messages
   * away once the turn ends; null when it wrote nothing or the log could not be read.
   */
  reply: z.string().nullable(),
});
export type Exercise = z.infer<typeof ExerciseSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  mode: SessionModeSchema,
  state: SessionStateSchema,
  topic: z.string(),
  trigger: TriggerKindSchema,
  sourceThreadId: z.string().nullable(),
  threadId: z.string().nullable(),
  pauseReason: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  asked: z.number(),
  answered: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

/** A topic the tab's Start section offers for a manual session, filled from data. */
export const TopicChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  topic: z.string(),
  trigger: TriggerKindSchema,
  refs: RefsSchema,
});
export type TopicChoice = z.infer<typeof TopicChoiceSchema>;

/** Everything the banner and the tab show for one thread. */
export const ThreadViewSchema = z.object({
  /** Offers are made here: a top-level thread a person drives (`isHumanThread`). */
  eligible: z.boolean(),
  /**
   * A session can be started here by hand: any visible thread but this plugin's own session threads, so a
   * child (sub-agent) thread opened on demand qualifies too (`canStartByHand`).
   */
  canStart: z.boolean(),
  /** The live offer for this thread, if any. */
  offer: OfferSchema.nullable(),
  /** The session this thread hosts (a session thread, or "here" mode), if any. */
  hosted: SessionSchema.nullable(),
  /** The open (active or paused) session started from this thread, if it runs elsewhere. */
  started: SessionSchema.nullable(),
  offersOn: z.boolean(),
  projectKey: z.string(),
  projectName: z.string(),
  projectNever: z.boolean(),
  /** True when the plugin's offers are turned off in its settings. */
  offersOffGlobally: z.boolean(),
  /** Where a session started from this thread runs: a fork, unless the setting or the provider says otherwise. */
  sessionWhere: SessionModeSchema,
  /** This thread's workspace, for links in the offer's topic. */
  workspace: WorkspaceSchema.nullable(),
});
export type ThreadView = z.infer<typeof ThreadViewSchema>;

/** The card's renderer id (`bb.ui.requestInput`) and the timeline kind of its settled row. */
export const CARD_RENDERER_ID = "exercise";

/** What a card shows: the question and where to look. */
export const CardPayloadSchema = z.object({
  sessionId: z.string(),
  ordinal: z.number(),
  type: ExerciseTypeSchema,
  question: z.string(),
  files: z.array(z.string()),
  /** The session thread's workspace, for opening `files`; null when it has none. */
  environmentId: z.string().nullable(),
  /** The same workspace with its folder, for links in the question; absent on cards an earlier build opened. */
  workspace: WorkspaceSchema.nullable().optional(),
  topic: z.string(),
  /**
   * The answer form (`answer-form.ts`), checked by the server when asked. Read with `readAnswerForm`, not
   * here, so a form this build cannot read falls back to the plain text box instead of breaking the card.
   */
  form: z.json().optional(),
  /** Question k of at most n. */
  maxQuestions: z.number(),
  /** The agent's reply to the previous question (its `reply`), shown above this one; absent when there is none. */
  previous: z.object({ ordinal: z.number(), answered: z.boolean(), reply: z.string() }).optional(),
});
export type CardPayload = z.infer<typeof CardPayloadSchema>;

/** The longest answer a card takes, in characters; the card stops typing there and says so. */
export const ANSWER_MAX_CHARS = 20_000;

/** The longest question, in characters: room for the code a question must carry itself. */
export const QUESTION_MAX_CHARS = 8_000;

/** The longest agent reply kept with a question, in characters; a longer one is cut there. */
export const REPLY_MAX_CHARS = 20_000;

/** The longest draft form answer the server takes, as JSON characters; a form's own limits keep real ones far below. */
export const DRAFT_FIELDS_MAX_CHARS = 200_000;

/**
 * A card's unsent answer, saved as the learner types so it survives leaving the thread, a reload or another
 * device: the text box's answer, or the form's values by field id, and the confidence picked. The server
 * reads `fields` against the question's form (`draftValues`) when it saves and when it hands a draft back.
 */
export const CardDraftSchema = z.object({
  answer: z.string().max(ANSWER_MAX_CHARS).optional(),
  fields: z
    .record(z.string(), z.json())
    .refine((fields) => JSON.stringify(fields).length <= DRAFT_FIELDS_MAX_CHARS, "The draft is too large.")
    .optional(),
  confidence: z.number().int().min(1).max(5).nullable().optional(),
  /**
   * The card's revision of this draft, rising with every edit (`app/draft.ts`): the server keeps a draft
   * only over a lower one, so a save that arrives late never replaces a newer one.
   */
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CardDraft = z.infer<typeof CardDraftSchema>;

/** What a card submits. */
export const CardValueSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer"),
    /** The learner's text, or the summary of their form answer. */
    answer: z.string().min(1).max(ANSWER_MAX_CHARS),
    confidence: z.number().int().min(1).max(5),
    /** A form answer by field id; the server reads it against the question's form (`sanitizeValues`). */
    fields: z.record(z.string(), z.json()).optional(),
  }),
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("more-specific") }),
  z.object({ action: z.literal("pause") }),
]);
export type CardValue = z.infer<typeof CardValueSchema>;

/**
 * Reads what a card submitted. An answer is never turned into something else: one over the limit is
 * cut to it (`truncated`), and a confidence out of range is clamped. Anything unreadable is null, which
 * the server treats as an interrupted question, not as a Skip.
 */
export function readCardValue(raw: unknown): { value: CardValue; truncated: boolean } | null {
  const parsed = CardValueSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, truncated: false };
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { action?: unknown; answer?: unknown; confidence?: unknown; fields?: unknown };
  if (candidate.action !== "answer" || typeof candidate.answer !== "string" || candidate.answer.trim() === "") return null;
  const confidence = typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) ? Math.min(5, Math.max(1, Math.round(candidate.confidence))) : 3;
  const fields = candidate.fields !== null && typeof candidate.fields === "object" && !Array.isArray(candidate.fields) ? { fields: candidate.fields as Record<string, z.infer<ReturnType<typeof z.json>>> } : {};
  return { value: { action: "answer", answer: candidate.answer.slice(0, ANSWER_MAX_CHARS), confidence, ...fields }, truncated: candidate.answer.length > ANSWER_MAX_CHARS };
}

/** What the settled row in the transcript keeps: the question and the learner's own words. */
export const SettledRowSchema = z.object({
  question: z.string(),
  action: z.enum(["answer", "skip", "more-specific", "pause"]),
  answer: z.string().nullable(),
  confidence: z.number().nullable(),
  /** The card's workspace, for links in the question; absent on rows written before it was kept. */
  workspace: WorkspaceSchema.nullable().optional(),
  /** The answer form and the answer by field id, when the question had one; read with `readAnswerForm`. */
  form: z.json().optional(),
  fields: z.json().optional(),
});
export type SettledRow = z.infer<typeof SettledRowSchema>;

export const CONFIDENCE_LABELS: Record<number, string> = {
  1: "Guessing",
  2: "Unsure",
  3: "Fairly sure",
  4: "Sure",
  5: "Certain",
};
