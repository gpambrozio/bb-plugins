/**
 * Whether the thread behind an entry is still waiting on the user. The events
 * say when a thread moves on by itself, but three things fire nothing a plugin
 * hears: the user *reading* the thread (bb moves its `lastReadAt` past its
 * `latestAttentionAt`, which is what clears the sidebar's unread dot), the user
 * *answering* a pending interaction, and a thread vanishing without an
 * archive event. So the list RPC asks bb about each entry's thread first:
 *
 * - **answered**: the entry is for an interaction that is no longer pending —
 *   removed;
 * - **seen**: read since its attention, and the entry old enough that bb has
 *   had time to record that attention — removed, the user has been there;
 * - a **finish** on a thread that is working again is hidden but kept: a
 *   provider can report a turn as finished and carry on, and the hooks take
 *   the entry back for good when the next turn starts;
 * - **gone** (archived, deleted, missing) — removed, because it never comes back.
 *
 * Answers are cached for a short while so a burst of list calls does not turn
 * into one bb read per entry per call.
 */
import type { AttentionEntry } from "../shared/herald";
import type { Log, LivenessPort, ThreadFacts } from "./ports";
import type { AttentionStore } from "./store";

export const LIVENESS_TTL_MS = 30_000;

/**
 * bb records a thread's attention as the event lands, but an entry younger
 * than this is never judged "seen": the user may be reading the thread at the
 * very moment it finishes, and the sentence still has to reach the panel.
 */
export const SEEN_GRACE_MS = 15_000;

/**
 * How stale a reading may be when the question is "is it working right now?".
 * Short, because that is the one fact here that turns over in seconds.
 */
export const RUNNING_TTL_MS = 5_000;

type Verdict = "live" | "working" | "gone" | "seen" | "answered";

export function isRunningStatus(status: string): boolean {
  return status === "active" || status === "starting";
}

/** bb's unread rule, the one behind the sidebar's dot. */
export function isUnread(facts: { lastReadAt: number | null; latestAttentionAt: number }): boolean {
  return facts.lastReadAt === null || facts.latestAttentionAt > facts.lastReadAt;
}

export class Liveness {
  private readonly checked = new Map<string, { at: number; facts: ThreadFacts }>();
  private readonly interactions = new Map<string, { at: number; pending: boolean }>();

  constructor(
    private readonly port: LivenessPort,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  /** The entries a client should see; removes the ones whose thread is gone, read, or answered. */
  async visible(store: AttentionStore): Promise<AttentionEntry[]> {
    this.prune();
    const entries = store.list();
    const verdicts = await Promise.all(entries.map((entry) => this.verdictFor(entry)));
    const result: AttentionEntry[] = [];
    entries.forEach((entry, index) => {
      switch (verdicts[index]) {
        case "live":
          result.push(entry);
          break;
        case "working":
        case undefined:
          break;
        case "gone":
        case "seen":
        case "answered":
          // By event, not by thread: the entries were listed before the reads,
          // and a newer one may have been recorded since.
          store.removeIf(entry.threadId, (current) => current.eventId === entry.eventId);
          break;
      }
    });
    return result;
  }

  private async verdictFor(entry: AttentionEntry): Promise<Verdict> {
    const createdAt = new Date(entry.createdAt).getTime();
    /** A reading older than this cannot speak for this entry however fresh the cache is. */
    const judgeableFrom = (Number.isFinite(createdAt) ? createdAt : 0) + SEEN_GRACE_MS;

    // A finish is judged on a reading no older than `RUNNING_TTL_MS`. Every
    // other reason keeps the long cache — a thread waiting on a question is
    // running too, and that is the row worth showing.
    const finished = entry.reason === "finished";
    const cached = await this.factsFor(entry.threadId, finished ? this.now() - RUNNING_TTL_MS : 0);
    if (cached.kind === "gone") return "gone";
    if (finished && isRunningStatus(cached.status)) return "working";
    if (entry.requestId !== null) {
      return (await this.interactionPending(entry.threadId, entry.requestId)) ? "live" : "answered";
    }
    if (isUnread(cached)) return "live";
    if (this.now() < judgeableFrom) return "live";

    // About to delete on the strength of a read the cache may predate, so the
    // reading has to be new enough to have seen this entry's attention.
    const facts = await this.factsFor(entry.threadId, judgeableFrom);
    if (facts.kind === "gone") return "gone";
    return isUnread(facts) ? "live" : "seen";
  }

  /** Readings past their use, so the caches do not grow with every thread ever listed. */
  private prune(): void {
    const at = this.now();
    for (const [key, value] of this.checked) if (at - value.at >= LIVENESS_TTL_MS) this.checked.delete(key);
    for (const [key, value] of this.interactions) if (at - value.at >= LIVENESS_TTL_MS) this.interactions.delete(key);
  }

  private async factsFor(threadId: string, notBefore: number): Promise<ThreadFacts> {
    const at = this.now();
    const cached = this.checked.get(threadId);
    if (cached !== undefined && at - cached.at < LIVENESS_TTL_MS && cached.at >= notBefore) {
      return cached.facts;
    }
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

  private async interactionPending(threadId: string, interactionId: string): Promise<boolean> {
    const key = `${threadId}:${interactionId}`;
    const at = this.now();
    const cached = this.interactions.get(key);
    if (cached !== undefined && at - cached.at < LIVENESS_TTL_MS) return cached.pending;
    let pending: boolean;
    try {
      pending = await this.port.interactionPending(threadId, interactionId);
    } catch (error) {
      this.log.warn(
        `Could not check interaction ${interactionId} on thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      pending = true;
    }
    this.interactions.set(key, { at, pending });
    return pending;
  }
}
