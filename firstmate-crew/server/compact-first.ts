/**
 * Compact, then deliver (bb 0.47's `compactFirst` on a send). A message that reaches a thread autocompact
 * would compact right now — its rule on, at rest, idle past its deadline, over its threshold, not compacted
 * since its last turn (`dueNow`) — goes as one request: bb compacts the thread, then delivers the message.
 * Otherwise the message would go out over the whole context after its cache expired, and the thread would
 * run a turn before the next check could compact it. Only then: the threshold still applies after an idle
 * stretch, never to every turn.
 *
 * The mark is written first, as for a compaction from the check (`autocompact.ts`), so the check leaves the
 * thread alone until the compaction and the message's own turn have run; a mark that cannot be saved sends
 * the message plainly. When bb refuses (the thread stopped being idle, or its provider cannot compact),
 * nothing was delivered: the message goes as it would have, and the mark is relaxed to one turn.
 */
import { dueNow, dueText, type Due, type DueNowDeps } from "./autocompact";
import { errorText, type Log } from "./log";
import type { SendMode } from "./ports";
import type { CompactionMark } from "./store";

export interface CompactFirstDeps extends DueNowDeps {
  log: Log;
}

/** Sends through `send` with `mode`, or with `compact-first` when the thread is due for autocompact. */
export async function sendCompactingIfDue<T>(
  deps: CompactFirstDeps,
  threadId: string,
  mode: SendMode,
  send: (mode: SendMode) => Promise<T>,
): Promise<T> {
  const { log, store } = deps;
  let due: Due | null;
  try {
    due = await dueNow(deps, threadId);
  } catch (error) {
    log.warn(`Autocompact could not tell whether ${threadId} is due before a message to it, so the message goes as it is: ${errorText(error)}`);
    return send(mode);
  }
  if (due === null) return send(mode);

  const mark: CompactionMark = { afterSeq: due.lastTurn.seq, ok: true, at: deps.now() };
  try {
    await store.setCompactionMark(threadId, mark);
  } catch (error) {
    log.warn(`Autocompact could not save its mark for ${threadId}, so a message to it goes without compacting: ${errorText(error)}`);
    return send(mode);
  }

  let result: T;
  try {
    result = await send("compact-first");
  } catch (error) {
    log.warn(`bb would not compact ${threadId} before a message to it, so the message goes as it is: ${errorText(error)}`);
    try {
      await store.setCompactionMark(threadId, { ...mark, ok: false });
    } catch (markError) {
      log.warn(`Autocompact could not note that bb refused to compact ${threadId}, so it waits for two turns instead of one: ${errorText(markError)}`);
    }
    return send(mode);
  }
  log.info(`Autocompact compacted ${threadId} before delivering a message to it: ${dueText(due)}.`);
  return result;
}
