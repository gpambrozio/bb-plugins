/**
 * When and how the watch runner's queue (`watches.ts`) reaches the first mate.
 *
 * The first mate is asked for afresh on every delivery — by the stored id only — and the note goes
 * only while it is idle. A first mate mid-turn, or none at all, means wait: the runner keeps the queue
 * and tries again on the first mate's next `thread.idle` or the next minute's tick. The one send uses
 * `queue-if-active`, so a turn that starts between the check and the send holds the note rather than
 * being steered into.
 */
import type { ThreadsPort } from "./ports";
import type { Store } from "./store";
import type { DeliveryOutcome } from "./watches";

export interface DeliveryDeps {
  threads: ThreadsPort;
  store: Store;
}

export function createDeliver(deps: DeliveryDeps): (text: string) => Promise<DeliveryOutcome> {
  return async (text) => {
    const id = await deps.store.mateThreadId();
    if (id === null) return "wait";
    const mate = await deps.threads.get(id);
    if (mate === null || mate.status !== "idle") return "wait";
    await deps.threads.send(mate.id, text, "queue-if-active");
    return "sent";
  };
}
