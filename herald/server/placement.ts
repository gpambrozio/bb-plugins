/**
 * Which message each past sentence belongs to in its thread's timeline: the
 * message of its own turn that led to its event — the turn's final answer for
 * a finished turn, the answer before a question, plan, permission or error
 * (or the turn's prompt when it has none). bb's message metadata
 * (`experimental_messageMetadata`, bb 0.48.1) draws above a message and never
 * below one, so the sentence's card sits just above that message. It exists
 * when the event does, so a sentence shows as soon as it is written.
 *
 * Every top-level row carries its turn's id, a prompt the turn it started or
 * steered. The event's turn is that of the latest row at or before it that is
 * not a prompt (its work, its answers, its failure, its "Worked for" row): a
 * prompt the person sent meanwhile may already belong to the next turn, and
 * one bb has not delivered (queued) belongs to none. The message is chosen
 * among that turn's delivered top-level messages only.
 *
 * Only the messages at the timeline's top level count: a finished turn folds
 * its work, and the messages in it, into one "Worked for" row — its
 * intermediate answers, and a message another thread or bb sent into it while
 * it ran (a child's report steering its parent). A running turn is flat. So
 * the message is the turn's last one at or before the event; but when the
 * turn has folded and that is a prompt (the answers before the event are in
 * the fold), it is the turn's final answer.
 *
 * A place is settled, and saved with the sentence, once its turn can no
 * longer change: when no turn ran from before the page was read until after,
 * or when a later turn has started. Otherwise it is used for now and looked
 * for again on the next read, which the end of the turn brings
 * (`SENTENCES_CHANNEL`).
 *
 * The timeline is read newest page first, back past the oldest sentence still
 * to place, and at most `PLACEMENT_PAGES_MAX` pages: a sentence older than
 * that is given up on, once, rather than read for on every visit.
 */
import type { HistoryItem, PlacedSentence, PlacedSentences } from "../shared/herald";
import type { Log, TimelineMark, TimelineMessage, TimelinePort } from "./ports";

/** bb's pages hold twenty turns each; sixty turns back is past where anyone scrolls to find a sentence. */
export const PLACEMENT_PAGES_MAX = 3;

export interface Placement extends PlacedSentences {
  /** Places that will not change, by event id: a message id, or null for given up. For the history to keep. */
  settled: Map<string, string | null>;
}

/**
 * Never rejects: when bb cannot be read, or the caller goes (`signal`), the
 * places already found are kept and the rest wait.
 */
export async function placeSentences(
  threadId: string,
  items: readonly HistoryItem[],
  port: TimelinePort,
  log: Log,
  signal?: AbortSignal,
): Promise<Placement> {
  const settled = new Map<string, string | null>();
  const unsettled = new Map<string, string>();
  const open: HistoryItem[] = [];
  for (const item of items) {
    if (item.messageId !== undefined) continue;
    // A time that cannot be read cannot be placed; it is not looked for again.
    if (Number.isFinite(timeOf(item))) open.push(item);
    else settled.set(item.eventId, null);
  }
  if (open.length > 0) {
    try {
      await place(threadId, open, port, settled, unsettled, signal);
    } catch (error) {
      if (signal?.aborted !== true) log.warn(`Could not read ${threadId}'s timeline to place Herald's sentences in it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const sentences: PlacedSentence[] = [];
  for (const item of items) {
    const known = item.messageId !== undefined ? item.messageId : settled.get(item.eventId);
    const messageId = known !== undefined ? known : (unsettled.get(item.eventId) ?? null);
    if (messageId !== null) sentences.push({ eventId: item.eventId, reason: item.reason, createdAt: item.createdAt, text: item.text, messageId });
  }
  return { sentences, settled };
}

async function place(
  threadId: string,
  open: readonly HistoryItem[],
  port: TimelinePort,
  settled: Map<string, string | null>,
  unsettled: Map<string, string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Asked before the page is read, and again after: a page read while a turn
  // ran can hold an answer that turn folds away once it ends.
  const runningBefore = await port.running(threadId);
  const oldest = Math.min(...open.map(timeOf));
  const messages: TimelineMessage[] = [];
  const marks: TimelineMark[] = [];
  let cursor: Awaited<ReturnType<TimelinePort["page"]>>["older"] = null;
  let whole = false;
  for (let pages = 0; pages < PLACEMENT_PAGES_MAX; pages += 1) {
    const page = await port.page(threadId, cursor, signal);
    messages.push(...page.messages);
    marks.push(...page.marks);
    cursor = page.older;
    if (cursor === null) {
      whole = true;
      break;
    }
    // A message at or before the oldest sentence: every sentence's own message has been read.
    if (messages.some((message) => message.createdAt <= oldest)) break;
  }
  messages.sort((a, b) => a.createdAt - b.createdAt);
  // Every message from `reach` on has been read, so a sentence from then on can be placed.
  const reach = whole ? -Infinity : (messages[0]?.createdAt ?? Infinity);
  const delivered = messages.filter((message) => !message.undelivered);
  const latestTurn = latestTurnOf(delivered, marks);
  let idle: boolean | null = null;
  for (const item of open) {
    const at = timeOf(item);
    if (at < reach) {
      settled.set(item.eventId, null);
      continue;
    }
    const found = messageOf(at, delivered, marks);
    if (found === undefined) continue;
    // A turn that is over keeps its rows; the running one still folds and grows.
    idle ??= !runningBefore && !(await port.running(threadId));
    if (idle || (found.turnId !== null && found.turnId !== latestTurn)) settled.set(item.eventId, found.message.id);
    else unsettled.set(item.eventId, found.message.id);
  }
}

/** The turn of the newest delivered row: the one that runs, when one does. */
function latestTurnOf(delivered: readonly TimelineMessage[], marks: readonly TimelineMark[]): string | null {
  let latest: { turnId: string; at: number } | null = null;
  for (const { turnId, at } of [
    ...delivered.flatMap((message) => (message.turnId === null ? [] : [{ turnId: message.turnId, at: message.createdAt }])),
    ...marks.map((mark) => ({ turnId: mark.turnId, at: mark.startedAt })),
  ]) {
    if (latest === null || at >= latest.at) latest = { turnId, at };
  }
  return latest?.turnId ?? null;
}

/**
 * The message an event at `at` belongs to (`delivered` oldest first), and
 * its turn; undefined when nothing is known before the event.
 */
function messageOf(
  at: number,
  delivered: readonly TimelineMessage[],
  marks: readonly TimelineMark[],
): { message: TimelineMessage; turnId: string | null } | undefined {
  // At the event's own millisecond counts as before it: that row led to it.
  const ownRows = [
    ...marks.map((mark) => ({ turnId: mark.turnId, at: mark.startedAt })),
    ...delivered.flatMap((message) => (message.role === "assistant" && message.turnId !== null ? [{ turnId: message.turnId, at: message.createdAt }] : [])),
  ].filter((row) => row.at <= at);
  const turnId = ownRows.sort((a, b) => a.at - b.at).at(-1)?.turnId ?? null;
  if (turnId === null) {
    // Nothing of a turn before the event: the prompt that led to it, if any.
    const prompt = delivered.filter((message) => message.role === "user" && message.createdAt <= at).at(-1);
    return prompt === undefined ? undefined : { message: prompt, turnId: prompt.turnId };
  }
  const inTurn = delivered.filter((message) => message.turnId === turnId);
  const before = inTurn.filter((message) => message.createdAt <= at).at(-1);
  const folded = marks.some((mark) => mark.folded && mark.turnId === turnId);
  const finalAnswer = inTurn.filter((message) => message.role === "assistant").at(-1);
  if (folded && (before === undefined || before.role === "user") && finalAnswer !== undefined) return { message: finalAnswer, turnId };
  // A turn whose prompt carries no turn id (a thread's first): the prompt before the event.
  const message = before ?? inTurn[0] ?? delivered.filter((candidate) => candidate.role === "user" && candidate.createdAt <= at).at(-1);
  return message === undefined ? undefined : { message, turnId };
}

function timeOf(item: HistoryItem): number {
  return Date.parse(item.createdAt);
}
