/**
 * Turns what the events hand us — a pending interaction, the end of a turn, a
 * thread's prompt history — into the plain text an entry carries and the
 * sentence that is spoken. Nothing here touches the network, which is what
 * makes it the part with tests.
 */
import { z } from "zod";

import type { AttentionReason } from "../shared/herald";
import type { Interaction, PromptRecord, ThreadEventRow } from "./ports";

export interface InteractionDescription {
  reason: AttentionReason;
  headline: string;
  detail: string | null;
}

function nonEmpty(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * What to show and say for a pause. bb hands every provider's request over in
 * one shape: a `user_question` with its questions and options, an `approval`
 * whose subject says what is being approved (a plan, a command, a file change,
 * extra permissions, a tool), a provider's own request kind with a title, or
 * another plugin's request with a title and presentation.
 */
export function describeInteraction(interaction: Interaction): InteractionDescription {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    const first = payload.questions[0];
    const headline = nonEmpty(first?.prompt) ?? nonEmpty(first?.shortLabel) ?? "Has a question for you";
    const options = (first?.options ?? []).map((option) => option.label.trim()).filter((label) => label !== "");
    const suffix = payload.questions.length > 1 ? ` (${payload.questions.length} questions)` : "";
    return {
      reason: "question",
      headline: `${headline}${suffix}`,
      detail: options.length > 0 ? options.join(" / ") : null,
    };
  }
  if (payload.kind === "approval") {
    const subject = payload.subject;
    switch (subject.kind) {
      case "plan":
        return {
          reason: "plan",
          headline: "Plan ready for your approval",
          detail: nonEmpty(subject.plan) === null ? null : firstWords(subject.plan, 60),
        };
      case "command":
        return {
          reason: "permission",
          headline: nonEmpty(payload.reason) ?? "Wants to run a command",
          detail: nonEmpty(subject.command),
        };
      case "file_change":
        return {
          reason: "permission",
          headline: nonEmpty(payload.reason) ?? "Wants to change files",
          detail: nonEmpty(subject.writeScope),
        };
      case "permission_grant":
        return {
          reason: "permission",
          headline: nonEmpty(payload.reason) ?? "Wants extra permissions",
          detail: nonEmpty(subject.toolName),
        };
      case "tool_use":
        return {
          reason: "permission",
          headline: nonEmpty(subject.presentation.title) ?? nonEmpty(payload.reason) ?? `Wants to use ${subject.tool}`,
          detail: nonEmpty(subject.presentation.detail),
        };
    }
  }
  if (payload.kind === "plugin") {
    return {
      reason: "question",
      headline: nonEmpty(payload.title) ?? "Has a question for you",
      detail: nonEmpty(payload.presentation?.detail),
    };
  }
  return { reason: "question", headline: nonEmpty(payload.title) ?? "Has a question for you", detail: null };
}

/**
 * The user's most recent message, so the summary knows what was asked for.
 * Only what the user could see counts: text marked agent-only is context a
 * plugin or a parent thread slipped in, not the request.
 */
export function lastPrompt(history: readonly PromptRecord[]): string | null {
  let newest: PromptRecord | null = null;
  for (const record of history) {
    if (newest === null || record.createdAt > newest.createdAt) newest = record;
  }
  if (newest === null) return null;
  return visibleText(newest.input);
}

/** The text parts of a message the user could see; agent-only context is left out. */
function visibleText(input: ReadonlyArray<{ type: string; text?: string; visibility?: string | null }>): string | null {
  const text = input
    .filter((part) => part.type === "text" && part.visibility !== "agent-only")
    .map((part) => part.text ?? "")
    .join("\n");
  return nonEmpty(text);
}

/** The event-log rows `turnRequest` reads. */
export const TURN_REQUEST_EVENT_TYPES = ["turn/input/accepted", "client/turn/rejected", "client/turn/requested"] as const;

const AcceptedSchema = z.object({ clientRequestId: z.string() });
const RejectedSchema = z.object({ requestId: z.string() });
const RequestedSchema = z.object({
  requestId: z.string(),
  initiator: z.string().nullish(),
  input: z.array(z.object({ type: z.string(), text: z.string().optional(), visibility: z.string().nullish() })),
});

/**
 * The request the thread's newest turn settled: the newest row that ends a
 * request's wait — `turn/input/accepted` (`clientRequestId`), or
 * `client/turn/rejected` (`requestId`) for one bb refused at the door, an
 * auth or rate-limit failure, which never gets an acceptance. A request
 * still queued has neither, so it is never taken for the turn.
 */
function settledRequest(rows: readonly ThreadEventRow[]): { id: string; seq: number } | null {
  for (const row of rows) {
    if (row.type === "turn/input/accepted") {
      const accepted = AcceptedSchema.safeParse(row.data);
      if (accepted.success) return { id: accepted.data.clientRequestId, seq: row.seq };
    } else if (row.type === "client/turn/rejected") {
      const rejected = RejectedSchema.safeParse(row.data);
      if (rejected.success) return { id: rejected.data.requestId, seq: row.seq };
    }
  }
  return null;
}

/**
 * The message the thread's newest turn took in, from its event log: the
 * newest accepted or rejected input (`settledRequest`) names its
 * `client/turn/requested` row, whose visible text this is. Unlike the prompt
 * history, it includes what bb or another thread sent — a child's completion
 * report starts its parent's turn — and one from another thread is marked as
 * such, since the prompt calls it the developer's request. `rows` are newest
 * first; null when the settled input or its request is not among them.
 */
export function turnRequest(rows: readonly ThreadEventRow[]): string | null {
  const settled = settledRequest(rows);
  if (settled === null) return null;
  for (const row of rows) {
    if (row.type !== "client/turn/requested" || row.seq > settled.seq) continue;
    const request = RequestedSchema.safeParse(row.data);
    if (!request.success || request.data.requestId !== settled.id) continue;
    const text = visibleText(request.data.input);
    if (text === null) return null;
    return request.data.initiator === "agent" ? `[Sent by another agent thread] ${text}` : text;
  }
  return null;
}

/** Markdown and code punctuation read aloud is noise; strip what a voice would spell out. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `maxWords` words, cut at a sentence end when one comes first. */
export function firstWords(text: string, maxWords: number): string {
  const words = plainText(text).split(" ").filter((word) => word !== "");
  if (words.length === 0) return "";
  const taken = words.slice(0, maxWords);
  const joined = taken.join(" ");
  const sentenceEnd = joined.search(/[.!?](\s|$)/);
  if (sentenceEnd > 20) return joined.slice(0, sentenceEnd + 1);
  return taken.length < words.length ? `${joined}…` : joined;
}

/** One line of at most `max` characters, for a preview under a title. */
export function preview(text: string, max = 90): string {
  const line = plainText(text);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export interface SpeechSource {
  projectName: string | null;
  threadTitle: string | null;
  reason: AttentionReason;
  headline: string;
  detail: string | null;
}

/** What to call the work: the thread's title if it has one, else the project's name. */
export function displayName(source: { projectName: string | null; threadTitle: string | null }): string | null {
  return source.threadTitle?.trim() || source.projectName?.trim() || null;
}

/**
 * How much of a name, a headline or a detail the plain sentence says. A
 * permission can carry a command kilobytes long; the card keeps all of it,
 * the voice says the start.
 */
export const SPOKEN_NAME_MAX = 80;
export const SPOKEN_PART_MAX = 160;

/**
 * The sentence Herald speaks: the event kind stated plainly,
 * with the start of the headline and of whatever detail there is. Deliberately
 * dull — it has to be right without having read anything — and short, since it
 * is spoken (under 500 characters whatever the event carried).
 */
export function fallbackSpeech(source: SpeechSource): string {
  const name = preview(displayName(source) ?? "A thread", SPOKEN_NAME_MAX);
  const headline = preview(source.headline, SPOKEN_PART_MAX);
  const detail = source.detail === null ? "" : preview(source.detail, SPOKEN_PART_MAX);
  switch (source.reason) {
    case "question":
      return `${name} has a question: ${headline}${detail === "" ? "" : ` Options: ${detail}.`}`;
    case "plan":
      return `${name} has a plan ready for your approval. ${headline}`;
    case "permission":
      return `${name} is asking for permission. ${headline}${detail === "" ? "" : ` Command: ${detail}.`}`;
    case "finished":
      return detail === "" ? `${name} finished.` : `${name} finished. ${firstWords(detail, 30)}`;
    case "error":
      return `${name} stopped with an error. ${headline}`;
  }
}
