/**
 * What the server and the app share: the shapes of offers, sessions and exercises as the app sees
 * them, and the values a card submits. Plain zod and constants, no SDK import, so the app bundle can
 * import it at run time (see the root AGENTS.md, *Dependencies*).
 */
import { z } from "zod";

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
  /** Null when the thread is not one the plugin works with (a child, a worker, someone else's plugin thread). */
  eligible: z.boolean(),
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
  topic: z.string(),
  /** Question k of at most n. */
  maxQuestions: z.number(),
});
export type CardPayload = z.infer<typeof CardPayloadSchema>;

/** What a card submits. */
export const CardValueSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), answer: z.string().min(1).max(20_000), confidence: z.number().int().min(1).max(5) }),
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("more-specific") }),
  z.object({ action: z.literal("pause") }),
]);
export type CardValue = z.infer<typeof CardValueSchema>;

/** What the settled row in the transcript keeps: the question and the learner's own words. */
export const SettledRowSchema = z.object({
  question: z.string(),
  action: z.enum(["answer", "skip", "more-specific", "pause"]),
  answer: z.string().nullable(),
  confidence: z.number().nullable(),
});
export type SettledRow = z.infer<typeof SettledRowSchema>;

export const CONFIDENCE_LABELS: Record<number, string> = {
  1: "Guessing",
  2: "Unsure",
  3: "Fairly sure",
  4: "Sure",
  5: "Certain",
};
