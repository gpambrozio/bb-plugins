/**
 * No notification for the first mate's no-op reply (the `mateQuietShipshape` setting, off by default).
 *
 * The charter (§9) has the first mate reply exactly `Captain, shipshape.` when there was nothing to do, and
 * bb notifies the captain of that turn like any other. bb's push sender waits two seconds after a turn ends
 * and drops a turn the captain has read by then, so FirstMate marks the first mate's thread read as soon as
 * such a turn ends. No notification level changes, so crewmates, which an ancestor's level would cap, keep
 * theirs; every other turn keeps bb's own notification. `markRead` marks the whole thread, so it is used
 * only when nothing before the no-op is unread (`safeToMark`). That wait and read check are bb's
 * internals, not its contract: if they change, or the mark comes late or fails, the captain gets the
 * notification as before, and nothing worse.
 */
import type { Log } from "./log";
import { errorText } from "./log";
import type { ReadState, RestState, ThreadsPort, TurnEvent } from "./ports";
import type { Store } from "./store";

/**
 * The charter's no-op reply: exactly `Captain, shipshape.`. Case, spacing, the comma and the closing
 * punctuation may differ; any other word makes it a real message.
 */
const NO_OP_REPLY = /^captain,?\s+shipshape\s*[.!…]*$/iu;

/** Whether the first mate's reply is the charter's no-op, which tells the captain nothing new. */
export function isNoOpReply(text: string): boolean {
  return NO_OP_REPLY.test(text.trim());
}

export interface QuietShipshapeDeps {
  threads: Pick<ThreadsPort, "restState" | "lastText" | "markRead" | "readState" | "recentTurnEvents">;
  store: Pick<Store, "mateThreadId">;
  /** The setting, read afresh each time. */
  enabled: () => Promise<boolean>;
  log: Log;
}

/** What one look at the thread finds: its rest, latest text, read watermark and latest turn events. */
interface Snapshot {
  rest: RestState | null;
  text: string | null;
  read: ReadState | null;
  /** Newest first: this turn's end, its start, the previous turn's end. */
  turns: TurnEvent[];
}

async function look(threads: QuietShipshapeDeps["threads"], threadId: string): Promise<Snapshot> {
  const [rest, text, read, turns] = await Promise.all([
    threads.restState(threadId),
    threads.lastText(threadId),
    threads.readState(threadId),
    threads.recentTurnEvents(threadId, 3),
  ]);
  return { rest, text, read, turns };
}

/**
 * Whether marking the thread read now would cost the captain nothing but the no-op's notification:
 *
 * - the no-op is the latest turn and the thread is at rest after it: idle, nothing queued, no question or
 *   approval waiting, the latest event the turn's end and its latest text still the no-op;
 * - everything before it was already read: bb's read watermark is at or after the end of the turn before
 *   it. `markRead` marks the whole thread, so an unread reply before the no-op — whose notification bb may
 *   still be holding in the same two-second window — would be lost with it. A thread with no earlier turn
 *   has nothing before it to lose.
 */
function safeToMark(snapshot: Snapshot): boolean {
  const { rest, text, read, turns } = snapshot;
  if (rest === null || read === null || text === null) return false;
  if (rest.status !== "idle" || rest.queuedMessages > 0 || rest.pendingInteractions > 0) return false;
  if (!isNoOpReply(text)) return false;
  const [end, start, previous] = turns;
  if (end?.type !== "completed" || start?.type !== "started") return false;
  if (previous === undefined) return true;
  if (previous.type !== "completed") return false;
  return read.lastReadAt !== null && read.lastReadAt >= previous.at;
}

/** Nothing happened between two looks: the same latest turn, the same attention and read watermark. */
function unchanged(first: Snapshot, second: Snapshot): boolean {
  return (
    first.turns[0]?.seq === second.turns[0]?.seq &&
    first.read?.latestAttentionAt === second.read?.latestAttentionAt &&
    first.read?.lastReadAt === second.read?.lastReadAt
  );
}

/**
 * A thread finished a turn with this closing text. Marks it read when the setting is on, the thread is the
 * stored first mate, the reply is the no-op, and `safeToMark` holds on two looks taken one after the other
 * that found nothing changed between them. bb has no read mark conditioned on a turn, so any new attention
 * that arrives while the second look's reads and the mark request are in flight — a reply, a question or
 * an approval, or an error as soon as a turn starts — is marked read too. That interval is normally short,
 * not bounded; a reply usually takes seconds. Answers whether it marked. A failed read or mark is logged
 * and leaves bb's notification to go out.
 */
export async function quietShipshape(deps: QuietShipshapeDeps, threadId: string, text: string | null): Promise<boolean> {
  if (text === null || !isNoOpReply(text)) return false;
  try {
    const [enabled, mateId] = await Promise.all([deps.enabled(), deps.store.mateThreadId()]);
    if (!enabled || mateId !== threadId) return false;
    const first = await look(deps.threads, threadId);
    if (!safeToMark(first)) return false;
    // Again, right before the mark: abstain on any change since the first look.
    const second = await look(deps.threads, threadId);
    if (!safeToMark(second) || !unchanged(first, second)) return false;
    await deps.threads.markRead(threadId);
    return true;
  } catch (error) {
    deps.log.warn(`Could not mark the first mate's "Captain, shipshape." turn read, so bb notifies of it: ${errorText(error)}`);
    return false;
  }
}
