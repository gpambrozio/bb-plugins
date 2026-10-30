/**
 * Where each past sentence sits in its thread's timeline: above the first
 * message after its event — the next prompt after a finished turn or an
 * error, the turn's answer after a question it asked. bb's message metadata
 * (`experimental_messageMetadata`, bb 0.48.1) draws above a message and never
 * below one, so "right after the event" is "above the next message". The
 * newest sentence, with nothing after it yet, waits; the composer banner
 * shows it meanwhile.
 *
 * Only the messages at the timeline's top level count: a finished turn folds
 * its work, and the messages in it, into one "Worked for" row. A place is
 * settled, and saved with the sentence, when the message is a prompt (those
 * never fold) or no turn is running (nothing will fold any more); otherwise
 * it is used for now and looked for again on the next read.
 *
 * The timeline is read newest page first, back past the oldest sentence still
 * to place, and at most `PLACEMENT_PAGES_MAX` pages: a sentence older than
 * that is given up on, once, rather than read for on every visit.
 */
import type { HistoryItem, PlacedSentence, PlacedSentences } from "../shared/herald";
import type { Log, TimelineMessage, TimelinePort } from "./ports";

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
  let waitingSince: number | null = null;
  for (const item of items) {
    const known = item.messageId !== undefined ? item.messageId : settled.get(item.eventId);
    const messageId = known !== undefined ? known : (unsettled.get(item.eventId) ?? null);
    if (messageId !== null) sentences.push({ eventId: item.eventId, reason: item.reason, createdAt: item.createdAt, text: item.text, messageId });
    if (known === undefined) waitingSince = Math.min(waitingSince ?? Infinity, timeOf(item));
  }
  return { sentences, waitingSince, settled };
}

async function place(
  threadId: string,
  open: readonly HistoryItem[],
  port: TimelinePort,
  settled: Map<string, string | null>,
  unsettled: Map<string, string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const oldest = Math.min(...open.map(timeOf));
  const messages: TimelineMessage[] = [];
  let cursor: Awaited<ReturnType<TimelinePort["page"]>>["older"] = null;
  let whole = false;
  for (let pages = 0; pages < PLACEMENT_PAGES_MAX; pages += 1) {
    const page = await port.page(threadId, cursor, signal);
    messages.push(...page.messages);
    cursor = page.older;
    if (cursor === null) {
      whole = true;
      break;
    }
    if (messages.some((message) => message.createdAt < oldest)) break;
  }
  messages.sort((a, b) => a.createdAt - b.createdAt);
  // Every message from `reach` on has been read, so a sentence from then on can be placed.
  const reach = whole ? -Infinity : (messages[0]?.createdAt ?? Infinity);
  let running: boolean | null = null;
  for (const item of open) {
    const at = timeOf(item);
    if (at < reach) {
      settled.set(item.eventId, null);
      continue;
    }
    // Strictly after: a message at the event's own millisecond is the one that led to it.
    const next = messages.find((message) => message.createdAt > at);
    if (next === undefined) continue;
    if (next.role === "user") {
      settled.set(item.eventId, next.id);
      continue;
    }
    running ??= await port.running(threadId);
    if (running) unsettled.set(item.eventId, next.id);
    else settled.set(item.eventId, next.id);
  }
}

function timeOf(item: HistoryItem): number {
  return Date.parse(item.createdAt);
}
