/**
 * How a helper's turn ended, as the events report it.
 *
 * A hidden thread is hidden from the sidebar, not from plugins: bb delivers its
 * `thread.active`, `thread.idle`, `thread.failed` and `interaction.pending` to
 * every listener, this plugin's included. So instead of polling the helper,
 * `server/hooks.ts` routes the helpers' own events here, and `summarize` waits
 * on them. `thread.idle` even carries the helper's reply.
 *
 * An outcome can arrive before anyone waits for it — the helper is fast, or the
 * spawn call resolved late — so it is held for a while rather than dropped.
 */

export type HelperOutcome =
  | { kind: "idle"; text: string | null }
  | { kind: "failed"; error: string | null }
  /** The helper asked the user something, which a summary must never do. */
  | { kind: "interaction" };

/** How long an outcome nobody has waited for yet is kept. */
export const EARLY_OUTCOME_TTL_MS = 120_000;

export class HelperOutcomes {
  private readonly waiters = new Map<string, { resolve: (outcome: HelperOutcome) => void; reject: (error: Error) => void }>();
  private readonly early = new Map<string, { outcome: HelperOutcome; at: number }>();
  /** Helpers seen running. An idle before that is a thread settling in, not a reply. */
  private readonly running = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  active(threadId: string): void {
    this.running.add(threadId);
  }

  idle(threadId: string, text: string | null): void {
    if (!this.running.has(threadId) && (text ?? "").trim() === "") return;
    this.settle(threadId, { kind: "idle", text });
  }

  failed(threadId: string, error: string | null): void {
    this.settle(threadId, { kind: "failed", error });
  }

  interaction(threadId: string): void {
    this.settle(threadId, { kind: "interaction" });
  }

  /** Resolves with the helper's outcome; rejects once `timeoutMs` has passed without one. */
  wait(threadId: string, timeoutMs: number): Promise<HelperOutcome> {
    const held = this.early.get(threadId);
    if (held !== undefined) {
      this.early.delete(threadId);
      return Promise.resolve(held.outcome);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(threadId);
        reject(new Error(`The summary helper did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.waiters.set(threadId, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /**
   * Fails every wait at once — on unload, so each summary's `finally` stops
   * and puts away its helper while bb still answers, instead of at its timeout.
   */
  cancelAll(reason: string): void {
    const waiting = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiting) waiter.reject(new Error(reason));
  }

  /** Drops what is known about a helper once it is put away. */
  forget(threadId: string): void {
    this.running.delete(threadId);
    this.early.delete(threadId);
  }

  private settle(threadId: string, outcome: HelperOutcome): void {
    this.running.delete(threadId);
    const waiter = this.waiters.get(threadId);
    if (waiter !== undefined) {
      this.waiters.delete(threadId);
      waiter.resolve(outcome);
      return;
    }
    const at = this.now();
    for (const [id, held] of this.early) {
      if (at - held.at > EARLY_OUTCOME_TTL_MS) this.early.delete(id);
    }
    this.early.set(threadId, { outcome, at });
  }
}
