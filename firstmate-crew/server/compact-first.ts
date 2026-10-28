/**
 * Compact, then deliver (bb 0.47's `compactFirst` on a send). A message that reaches a thread autocompact
 * would compact right now — its rule on, at rest, idle past its deadline, over its threshold, not compacted
 * since its last turn (`dueNow`) — goes as one request: bb compacts the thread, then delivers the message.
 * Otherwise the message would go out over the whole context after its cache expired, and the thread would
 * run a turn before the next check could compact it. Only then: the threshold still applies after an idle
 * stretch, never to every turn.
 *
 * It holds the `mate` lock from its assessment to the send, as the check's compaction does, and assesses
 * again once it has the lock, so the check, a launch, an adoption, a release or another message that got
 * there first is respected: one idle stretch is compacted once. A first look without the lock keeps a
 * message to a thread that is not due from waiting on it. Never call it with the lock held.
 *
 * The mark is written first, as for the check's compaction (`autocompact.ts`), so the check leaves the
 * thread alone until the compaction and the message's own turn have run; a mark that cannot be saved sends
 * the message plainly. When bb refuses outright (`CompactFirstRefused`: the thread stopped being idle, or
 * its provider cannot compact) nothing was compacted or delivered, so the message goes as it would have and
 * the mark is relaxed to one turn. Any other failure may have come after bb accepted the request: it is
 * passed on, unsent again, with the mark kept as accepted.
 */
import { dueNow, dueText, type Due, type DueNowDeps } from "./autocompact";
import { errorText, type Log } from "./log";
import { CompactFirstRefused, type SendMode } from "./ports";
import type { CompactionMark } from "./store";

export interface CompactFirstDeps extends DueNowDeps {
  log: Log;
  /** The `mate` lock, which the check's compactions, launch, adoption and release also take. */
  withMateLock: <T>(work: () => Promise<T>) => Promise<T>;
}

/** The thread's case for compaction now, or null; a failed read is logged and counts as none. */
async function dueOrNull(deps: CompactFirstDeps, threadId: string): Promise<Due | null> {
  try {
    return await dueNow(deps, threadId);
  } catch (error) {
    deps.log.warn(`Autocompact could not tell whether ${threadId} is due before a message to it, so the message goes as it is: ${errorText(error)}`);
    return null;
  }
}

/** Sends through `send` with `mode`, or with `compact-first` when the thread is due for autocompact. */
export async function sendCompactingIfDue<T>(
  deps: CompactFirstDeps,
  threadId: string,
  mode: SendMode,
  send: (mode: SendMode) => Promise<T>,
): Promise<T> {
  if ((await dueOrNull(deps, threadId)) === null) return send(mode);
  return deps.withMateLock(() => sendUnderLock(deps, threadId, mode, send));
}

async function sendUnderLock<T>(
  deps: CompactFirstDeps,
  threadId: string,
  mode: SendMode,
  send: (mode: SendMode) => Promise<T>,
): Promise<T> {
  const { log, store } = deps;
  // Read again under the lock: whoever held it may have compacted, marked, released or adopted.
  const due = await dueOrNull(deps, threadId);
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
    if (!(error instanceof CompactFirstRefused)) throw error;
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
