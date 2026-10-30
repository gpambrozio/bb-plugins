/**
 * No notification for the first mate's no-op reply (the `mateQuietShipshape` setting, off by default).
 *
 * The charter (§9) has the first mate reply exactly `Captain, shipshape.` when there was nothing to do, and
 * bb notifies the captain of that turn like any other. bb's push sender waits two seconds after a turn ends
 * and drops a turn the captain has read by then, so FirstMate marks the first mate's thread read as soon as
 * such a turn ends. No notification level changes, so crewmates, which an ancestor's level would cap, keep
 * theirs; every other turn keeps bb's own notification. That wait and read check are bb's internals, not
 * its contract: if they change, or the mark comes late or fails, the captain gets the notification as
 * before, and nothing worse.
 */
import type { Log } from "./log";
import { errorText } from "./log";
import type { ThreadsPort } from "./ports";
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
  threads: Pick<ThreadsPort, "restState" | "lastText" | "markRead">;
  store: Pick<Store, "mateThreadId">;
  /** The setting, read afresh each time. */
  enabled: () => Promise<boolean>;
  log: Log;
}

/**
 * A thread finished a turn with this closing text. Marks it read when the setting is on, the thread is the
 * stored first mate, the reply is the no-op, and that turn is still the latest and at rest: idle, nothing
 * queued, no question or approval waiting, and its last text still the no-op. Answers whether it did. A
 * failed read or mark is logged and leaves bb's notification to go out.
 */
export async function quietShipshape(deps: QuietShipshapeDeps, threadId: string, text: string | null): Promise<boolean> {
  if (text === null || !isNoOpReply(text)) return false;
  try {
    const [enabled, mateId] = await Promise.all([deps.enabled(), deps.store.mateThreadId()]);
    if (!enabled || mateId !== threadId) return false;
    const [rest, latest] = await Promise.all([deps.threads.restState(threadId), deps.threads.lastText(threadId)]);
    if (rest === null || rest.status !== "idle" || rest.runtimeStatus !== "idle") return false;
    if (rest.queuedMessages > 0 || rest.pendingInteractions > 0) return false;
    if (latest === null || !isNoOpReply(latest)) return false;
    await deps.threads.markRead(threadId);
    return true;
  } catch (error) {
    deps.log.warn(`Could not mark the first mate's "Captain, shipshape." turn read, so bb notifies of it: ${errorText(error)}`);
    return false;
  }
}
