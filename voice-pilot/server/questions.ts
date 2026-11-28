/**
 * bb's pending interactions as the voice reads and answers them. bb has three that a voice can act on:
 *
 * - **A provider's question** (`user_question`: Claude Code's own AskUserQuestion, say), answered with
 *   `threads.interactions.resolve({ resolution: { kind: "user_answer", answers } })`.
 * - **A question from bb's Ask User Question plugin** (a plugin form, `origin.pluginId` and `rendererId`
 *   `ask-user-question`, the questions in `payload.data`), answered with `threads.interactions.respond({
 *   value: { answers } })`: the same `answers` shape, read from bb 0.50's bundled plugin.
 * - **An approval** (a command, a file change, a permission, a plan, a tool), decided with
 *   `resolve({ resolution: { decision } })` from the decisions it offers — only after a read-back and your yes.
 *
 * Anything else (another plugin's form, a provider's custom request) is read by its title only, and you
 * answer it in bb. Nothing here trusts the model: an option is one of the question's own, picked by its
 * number or its label, and a free-text answer is your words from the transcript.
 *
 * The shapes are parsed here with zod from what bb answers, rather than typed from the SDK, so a field bb
 * renames makes a question unreadable (and said so) instead of answered wrongly.
 */
import { z } from "zod";

export const ASK_USER_QUESTION_PLUGIN = "ask-user-question";

/** One option as the voice says it: numbered from 1. */
export interface SpokenOption {
  n: number;
  label: string;
  description: string | null;
  /** What bb is sent for it. */
  value: string;
}

export interface SpokenQuestion {
  id: string;
  prompt: string;
  header: string | null;
  multiSelect: boolean;
  allowFreeText: boolean;
  required: boolean;
  options: SpokenOption[];
}

export type Decision = "allow_once" | "allow_for_session" | "deny";

export type Pending =
  | { kind: "question"; via: "provider" | "plugin"; interactionId: string; threadId: string; questions: SpokenQuestion[] }
  | {
      kind: "approval";
      interactionId: string;
      threadId: string;
      /** What it asks to do, in plain words. */
      what: string;
      /** The command (always whole: see `COMMAND_VOICE_MAX`), the plan's opening, the files. */
      detail: string | null;
      reason: string | null;
      /** The decisions the voice may send: never an approval when `inBb` is set. */
      decisions: Decision[];
      /** Why only bb can approve it (a command too long to read aloud whole); null when the voice can. */
      inBb: string | null;
    }
  | { kind: "other"; interactionId: string; threadId: string; title: string };

const OptionSchema = z.object({ value: z.string(), label: z.string(), description: z.string().optional() });
const QuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  shortLabel: z.string().optional(),
  multiSelect: z.boolean().optional(),
  allowFreeText: z.boolean().optional(),
  required: z.boolean().optional(),
  options: z.array(OptionSchema).optional(),
});
const QuestionsSchema = z.object({ questions: z.array(QuestionSchema).min(1) });

const Base = z.object({ id: z.string(), threadId: z.string(), status: z.string() });
const ProviderQuestion = Base.extend({ payload: z.object({ kind: z.literal("user_question") }).and(QuestionsSchema) });
const PluginForm = Base.extend({
  origin: z.object({ kind: z.literal("plugin"), pluginId: z.string(), rendererId: z.string() }),
  payload: z.object({ kind: z.literal("plugin"), title: z.string(), data: z.unknown() }),
});
const Approval = Base.extend({
  payload: z.object({
    kind: z.literal("approval"),
    availableDecisions: z.array(z.string()),
    reason: z.string().nullable().optional(),
    subject: z.record(z.string(), z.unknown()).and(z.object({ kind: z.string() })),
  }),
});
const Titled = Base.extend({ payload: z.object({ title: z.string().optional(), kind: z.string() }) });

/** Text cut for speech: one line, at most `max` characters. */
export function spoken(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function questionsOf(data: z.infer<typeof QuestionsSchema>): SpokenQuestion[] {
  return data.questions.map((question) => ({
    id: question.id,
    prompt: spoken(question.prompt, 400),
    header: question.shortLabel === undefined ? null : spoken(question.shortLabel, 60),
    multiSelect: question.multiSelect ?? false,
    allowFreeText: question.allowFreeText ?? false,
    required: question.required ?? true,
    options: (question.options ?? []).map((option, index) => ({
      n: index + 1,
      label: spoken(option.label, 120),
      description: option.description === undefined ? null : spoken(option.description, 200),
      value: option.value,
    })),
  }));
}

const DECISIONS: readonly Decision[] = ["allow_once", "allow_for_session", "deny"];

/**
 * The longest command the voice reads aloud, and so may approve. A longer one is never cut for speech: the
 * cut-off part could be the one that matters (`…; rm -rf ./data`), and a yes would approve it unheard. It is
 * approved in bb instead; the voice may still deny it.
 */
export const COMMAND_VOICE_MAX = 300;

function approvalWhat(subject: Record<string, unknown>): { what: string; detail: string | null; inBb: string | null } {
  const text = (key: string) => (typeof subject[key] === "string" ? (subject[key] as string) : null);
  switch (subject.kind) {
    case "command": {
      const command = text("command");
      if (command === null) return { what: "run a command", detail: null, inBb: "bb did not say which command it is, so it cannot be approved by voice. Approve it in bb." };
      // Whitespace only is folded (a newline reads as a space): every character of the command is kept.
      const whole = command.replace(/\s+/gu, " ").trim();
      if (whole.length > COMMAND_VOICE_MAX) {
        return { what: "run a command", detail: null, inBb: `The command is too long to read aloud in full (${whole.length} characters), so it cannot be approved by voice. Approve it in bb.` };
      }
      return { what: "run a command", detail: whole, inBb: null };
    }
    case "file_change":
      return { what: "change files", detail: text("writeScope"), inBb: null };
    case "permission_grant":
      return { what: `get more permissions${text("toolName") === null ? "" : ` for ${text("toolName")}`}`, detail: null, inBb: null };
    case "plan":
      return { what: "go ahead with its plan", detail: text("plan") === null ? null : spoken(text("plan") ?? "", 1_200), inBb: null };
    case "tool_use":
      return { what: `use the tool ${text("tool") ?? "it names"}`, detail: null, inBb: null };
    default:
      return { what: "do something bb asks you to approve", detail: null, inBb: null };
  }
}

/** One of bb's pending interactions as the voice handles it; null when it is no longer pending. */
export function parsePending(interaction: unknown): Pending | null {
  const base = Base.safeParse(interaction);
  if (!base.success || base.data.status !== "pending") return null;
  const { id: interactionId, threadId } = base.data;
  const question = ProviderQuestion.safeParse(interaction);
  if (question.success) return { kind: "question", via: "provider", interactionId, threadId, questions: questionsOf(question.data.payload) };
  const form = PluginForm.safeParse(interaction);
  if (form.success) {
    const asked = form.data.origin.pluginId === ASK_USER_QUESTION_PLUGIN ? QuestionsSchema.safeParse(form.data.payload.data) : null;
    if (asked?.success === true) return { kind: "question", via: "plugin", interactionId, threadId, questions: questionsOf(asked.data) };
    return { kind: "other", interactionId, threadId, title: spoken(form.data.payload.title, 200) };
  }
  const approval = Approval.safeParse(interaction);
  if (approval.success) {
    const { what, detail, inBb } = approvalWhat(approval.data.payload.subject);
    const offered = DECISIONS.filter((decision) => approval.data.payload.availableDecisions.includes(decision));
    const decisions = inBb === null ? offered : offered.filter((decision) => decision === "deny");
    const reason = approval.data.payload.reason ?? null;
    return { kind: "approval", interactionId, threadId, what, detail, reason: reason === null ? null : spoken(reason, 300), decisions, inBb };
  }
  const titled = Titled.safeParse(interaction);
  return { kind: "other", interactionId, threadId, title: titled.success ? spoken(titled.data.payload.title ?? titled.data.payload.kind, 200) : "a request" };
}

export const DECISION_WORDS: Record<Decision, string> = {
  allow_once: "approve it this once",
  allow_for_session: "approve it for the rest of the session",
  deny: "deny it",
};

/** What the voice reads aloud of one pending interaction, in a thread named `thread`. */
export function readAloud(pending: Pending, thread: string): string {
  switch (pending.kind) {
    case "question":
      return pending.questions
        .map((question, index) => {
          const head = pending.questions.length > 1 ? `Question ${index + 1} of ${pending.questions.length}: ` : "";
          const options = question.options.map((option) => `${option.n}. ${option.label}${option.description === null ? "" : ` (${option.description})`}`).join("; ");
          const how = [
            question.options.length === 0 ? null : question.multiSelect ? "You may pick more than one." : "Pick one.",
            question.allowFreeText ? (question.options.length === 0 ? "Answer in your own words." : "Or answer in your own words.") : null,
          ].filter((part) => part !== null);
          return `${head}${question.prompt}${options === "" ? "" : ` Options: ${options}.`} ${how.join(" ")}`.trim();
        })
        .join("\n");
    case "approval": {
      const bare = (text: string) => text.replace(/[\s.!?:;,]+$/u, "");
      const detail = pending.detail === null ? "" : `: ${bare(pending.detail)}`;
      const reason = pending.reason === null ? "" : ` Its reason: ${bare(pending.reason)}.`;
      const choices = pending.decisions.map((decision) => DECISION_WORDS[decision]).join(", or ");
      if (pending.inBb !== null) {
        const deny = pending.decisions.includes("deny") ? " You can deny it here." : "";
        return `${thread} asks to ${pending.what}${detail}.${reason} ${pending.inBb}${deny}`;
      }
      return `${thread} asks to ${pending.what}${detail}.${reason} You can ${choices}.`;
    }
    case "other":
      return `${thread} is waiting on "${pending.title}", which cannot be answered by voice. Answer it in bb.`;
  }
}

/** How the model names its pick of one question: option numbers or labels, and/or your own words. */
export interface Pick {
  /** The question's number (1-based) or id; the only question when there is one. */
  question?: number | string;
  options?: (number | string)[];
  /** Answer with what you said since the question was read, word for word. */
  useSpokenWords?: boolean;
}

export type Answers = Record<string, { selected: string[]; freeText?: string }>;

/** The labels compared: case, spacing and a trailing "(Recommended)" ignored. */
function labelKey(label: string): string {
  return label
    .replace(/\(recommended\)\s*$/iu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function findOption(question: SpokenQuestion, pick: number | string): SpokenOption | null {
  const n = typeof pick === "number" ? pick : /^\s*\d+\s*$/u.test(pick) ? Number(pick) : null;
  if (n !== null) return question.options.find((option) => option.n === n) ?? null;
  const key = labelKey(String(pick));
  return question.options.find((option) => labelKey(option.label) === key) ?? null;
}

function findQuestion(questions: readonly SpokenQuestion[], ref: number | string | undefined): SpokenQuestion | null {
  if (ref === undefined) return questions.length === 1 ? (questions[0] ?? null) : null;
  if (typeof ref === "number" || /^\s*\d+\s*$/u.test(ref)) return questions[Number(ref) - 1] ?? null;
  return questions.find((question) => question.id === ref) ?? null;
}

/**
 * The answers so far: `prior` (from earlier calls for the same interaction) with `picks` added, and `words` (what
 * you said since the question was read, or since the last answer saved for it) as the one free-text answer; or
 * why not, as a sentence for the model. `open` lists the required questions still unanswered: nothing is sent
 * until it is empty. `said` is what the voice says back, every answer so far in question order.
 *
 * One free-text answer per call: a transcript span has no boundary between two answers, so "Call it Atlas.
 * Next Friday." would otherwise go to both "Project name?" and "Target date?". Each is asked and answered in
 * turn, and kept until the last one is.
 */
export function buildAnswers(
  questions: readonly SpokenQuestion[],
  picks: readonly Pick[],
  words: string | null,
  prior: Answers = {},
): { ok: true; answers: Answers; said: string; open: SpokenQuestion[] } | { ok: false; error: string } {
  if (picks.filter((pick) => pick.useSpokenWords === true).length > 1) {
    return {
      ok: false,
      error: "Only one question at a time can take the user's own words. Ask the first, call answer_question with its answer alone, then ask the next.",
    };
  }
  const answers: Answers = { ...prior };
  const now = new Set<string>();
  for (const pick of picks) {
    const question = findQuestion(questions, pick.question);
    if (question === null) return { ok: false, error: `There is no question ${String(pick.question ?? "")}; there are ${questions.length}. Name it by number.` };
    if (now.has(question.id)) return { ok: false, error: `Question ${questions.indexOf(question) + 1} is picked twice.` };
    now.add(question.id);
    const chosen: SpokenOption[] = [];
    for (const ref of pick.options ?? []) {
      const option = findOption(question, ref);
      if (option === null) return { ok: false, error: `"${String(ref)}" is not one of the options of "${question.prompt}". Read the options again.` };
      if (!chosen.includes(option)) chosen.push(option);
    }
    if (chosen.length > 1 && !question.multiSelect) return { ok: false, error: `"${question.prompt}" takes one option only.` };
    let freeText: string | undefined;
    if (pick.useSpokenWords === true) {
      if (!question.allowFreeText) return { ok: false, error: `"${question.prompt}" takes one of its options, not your own words.` };
      if (words === null) return { ok: false, error: "There are no words of the user's since the question was read. Ask them to say their answer." };
      freeText = words;
    }
    if (chosen.length === 0 && freeText === undefined) return { ok: false, error: `Pick an option for "${question.prompt}", or answer it with the user's own words.` };
    answers[question.id] = { selected: chosen.map((option) => option.value), ...(freeText === undefined ? {} : { freeText }) };
  }
  const said = questions.flatMap((question, index) => {
    const answer = answers[question.id];
    if (answer === undefined) return [];
    const labels = question.options
      .filter((option) => answer.selected.includes(option.value))
      .map((option) => option.label)
      .join(" and ");
    const text = answer.freeText === undefined ? labels : labels === "" ? `"${answer.freeText}"` : `${labels}, with "${answer.freeText}"`;
    return [questions.length > 1 ? `${index + 1}: ${text}` : text];
  });
  const open = questions.filter((question) => question.required && answers[question.id] === undefined);
  return { ok: true, answers, said: said.join("; "), open };
}
