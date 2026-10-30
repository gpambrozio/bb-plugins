/**
 * Which message each past sentence belongs to in its thread's timeline: the
 * message that led to its event — the turn's final answer for a finished
 * turn, the answer (or prompt) before a question, plan, permission or error.
 * bb's message metadata (`experimental_messageMetadata`, bb 0.48.1) draws
 * above a message and never below one, so the sentence's card sits just above
 * that message. It exists when the event does, so a sentence shows as soon as
 * it is written.
 *
 * Only the messages at the timeline's top level count: a finished turn folds
 * its work, and the messages in it, into one "Worked for" row — its
 * intermediate answers, and a message another thread or bb sent into it while
 * it ran (a child's report steering its parent). So the message is the last
 * top-level one at or before the event, unless the event happened inside a
 * turn that started after that message: then its messages are folded, and the
 * sentence goes to the first message after the turn's start, its final answer.
 *
 * A place is settled, and saved with the sentence, when the message is the
 * person's own prompt (those stay at the top level, even one sent mid-turn),
 * or when no turn ran from before the page was read until after (nothing will
 * fold any more); otherwise it is used for now and looked for again on the
 * next read, which the end of the turn brings (`SENTENCES_CHANNEL`).
 *
 * The timeline is read newest page first, back past the oldest sentence still
 * to place, and at most `PLACEMENT_PAGES_MAX` pages: a sentence older than
 * that is given up on, once, rather than read for on every visit.
 */
import type { HistoryItem, PlacedSentence, PlacedSentences } from "../shared/herald";
import type { Log, TimelineMessage, TimelinePort, TimelineTurn } from "./ports";

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
  const turns: TimelineTurn[] = [];
  let cursor: Awaited<ReturnType<TimelinePort["page"]>>["older"] = null;
  let whole = false;
  for (let pages = 0; pages < PLACEMENT_PAGES_MAX; pages += 1) {
    const page = await port.page(threadId, cursor, signal);
    messages.push(...page.messages);
    turns.push(...page.turns);
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
  let settles: boolean | null = null;
  for (const item of open) {
    const at = timeOf(item);
    if (at < reach) {
      settled.set(item.eventId, null);
      continue;
    }
    const found = messageOf(at, messages, turns);
    if (found === undefined) continue;
    const { message, inRunningTurn } = found;
    // Inside a turn still running, its final answer is yet to come: even a prompt is only for now.
    if (inRunningTurn) {
      unsettled.set(item.eventId, message.id);
      continue;
    }
    if (message.initiator === "user") {
      settled.set(item.eventId, message.id);
      continue;
    }
    settles ??= !runningBefore && !(await port.running(threadId));
    if (settles) settled.set(item.eventId, message.id);
    else unsettled.set(item.eventId, message.id);
  }
}

/**
 * The top-level message an event at `at` belongs to (`messages` oldest
 * first), and whether the event lies in a turn row still running.
 */
function messageOf(
  at: number,
  messages: readonly TimelineMessage[],
  turns: readonly TimelineTurn[],
): { message: TimelineMessage; inRunningTurn: boolean } | undefined {
  // At the event's own millisecond counts as before it: that message led to it.
  const before = messages.filter((message) => message.createdAt <= at).at(-1);
  const folded = turns.find(
    (turn) => turn.startedAt <= at && (turn.completedAt === null || at <= turn.completedAt) && turn.startedAt > (before?.createdAt ?? -Infinity),
  );
  const message = folded === undefined ? before : (messages.find((candidate) => candidate.createdAt >= folded.startedAt) ?? before);
  return message === undefined ? undefined : { message, inRunningTurn: folded !== undefined && folded.completedAt === null };
}

function timeOf(item: HistoryItem): number {
  return Date.parse(item.createdAt);
}
