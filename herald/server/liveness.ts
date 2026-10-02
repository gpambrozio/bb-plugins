/**
 * Whether the thread behind an entry still exists. An entry is the thread's
 * last Herald event — the sentence stays above the composer, read or not,
 * answered or not, until the next event replaces it — so the only thing that
 * takes one away here is the thread vanishing: archived, deleted or missing,
 * which can happen without an event the plugin hears. The list RPC asks bb
 * about each entry's thread first, with the answers cached for a short while
 * so a burst of list calls does not turn into one bb read per entry per call.
 *
 * bb's own unread rule and pending interactions decide what the *panel*
 * lists; that join happens in the app (`app/rows.ts`).
 */
import type { AttentionEntry } from "../shared/herald";
import type { Log, LivenessPort, ThreadFacts } from "./ports";
import type { AttentionStore } from "./store";

export const LIVENESS_TTL_MS = 30_000;

export class Liveness {
  private readonly checked = new Map<string, { at: number; facts: ThreadFacts }>();

  constructor(
    private readonly port: LivenessPort,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  /** The entries a client should see; removes the ones whose thread is gone. */
  async visible(store: AttentionStore): Promise<AttentionEntry[]> {
    this.prune();
    const entries = store.list();
    const facts = await Promise.all(entries.map((entry) => this.factsFor(entry.threadId)));
    const result: AttentionEntry[] = [];
    entries.forEach((entry, index) => {
      if (facts[index]?.kind === "gone") {
        // By event, not by thread: the entries were listed before the reads,
        // and a newer one may have been recorded since.
        store.removeIf(entry.threadId, (current) => current.eventId === entry.eventId);
      } else {
        result.push(entry);
      }
    });
    return result;
  }

  /** Readings past their use, so the cache does not grow with every thread ever listed. */
  private prune(): void {
    const at = this.now();
    for (const [key, value] of this.checked) if (at - value.at >= LIVENESS_TTL_MS) this.checked.delete(key);
  }

  private async factsFor(threadId: string): Promise<ThreadFacts> {
    const at = this.now();
    const cached = this.checked.get(threadId);
    if (cached !== undefined && at - cached.at < LIVENESS_TTL_MS) return cached.facts;
    let facts: ThreadFacts;
    try {
      facts = await this.port.facts(threadId);
    } catch (error) {
      // Cannot tell right now — a transport hiccup, most likely. Showing an
      // entry that may be stale beats losing one that is not.
      this.log.warn(`Could not check thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      facts = { kind: "open", status: "idle", lastReadAt: null, latestAttentionAt: at };
    }
    this.checked.set(threadId, { at, facts });
    return facts;
  }
}
