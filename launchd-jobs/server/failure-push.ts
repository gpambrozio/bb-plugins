import type { FailingEntry } from "../shared/channels";

/**
 * The opt-in push notification when a job starts failing.
 *
 * Every count of failing jobs is handed to `observe`, whether or not the
 * setting is on, and the jobs it names are stored as the ones already told
 * about. A job notifies only when it is failing now and was not in the stored
 * set: so nothing more is sent while it stays failing, a job that recovers (or
 * whose failure is acknowledged) leaves the set and notifies again the next
 * time it fails, and turning the setting on, reloading the plugin or
 * restarting bb sends nothing for a job that was already failing. With no
 * stored set at all (the first count ever), the count is only recorded.
 *
 * The set is re-read from storage on every count rather than cached, so a
 * new instance loaded beside the old one during a reload reads what the old
 * one last wrote.
 */
export interface FailurePushDeps {
  /** Whether the user has turned the notification on; read on every count. */
  enabled(): Promise<boolean>;
  /** The stored `hostId/id` keys, or undefined before the first count. */
  load(): Promise<string[] | undefined>;
  save(keys: string[]): Promise<void>;
  /** Sends one push notification; throws when it could not (an older bb, push notifications off). */
  send(notification: { title: string; body: string }): Promise<void>;
  warn(message: string): void;
}

function keyOf(entry: FailingEntry): string {
  return `${entry.hostId}/${entry.id}`;
}

function hostOf(key: string): string {
  return key.slice(0, key.indexOf("/"));
}

export function notificationFor(entry: FailingEntry): { title: string; body: string } {
  return {
    title: `${entry.name} failed on ${entry.hostName}`,
    body: `Its last run exited with code ${entry.exitCode}.`,
  };
}

export function createFailurePush(deps: FailurePushDeps) {
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  /** Set once a send has failed, so an older bb or push notifications being off is logged once. */
  let unavailable = false;

  async function step(failing: readonly FailingEntry[], unanswered: readonly string[]): Promise<void> {
    if (disposed) return;
    const [stored, enabled] = await Promise.all([deps.load(), deps.enabled()]);
    if (disposed) return;
    // A Mac that did not answer keeps its record: it has not recovered, it was not asked.
    const kept = (stored ?? []).filter((key) => unanswered.includes(hostOf(key)));
    const keys = [...new Set([...failing.map(keyOf), ...kept])].sort();
    const known = new Set(stored ?? []);
    const fresh = stored === undefined || !enabled ? [] : failing.filter((entry) => !known.has(keyOf(entry)));
    // Recorded before sending: a send cut short by a reload is lost, never repeated.
    if (stored === undefined || keys.length !== stored.length || keys.some((key) => !known.has(key))) await deps.save(keys);
    for (const entry of fresh) {
      if (disposed) return;
      try {
        await deps.send(notificationFor(entry));
        unavailable = false;
      } catch (error) {
        if (unavailable) continue;
        unavailable = true;
        const message = error instanceof Error ? error.message : String(error);
        deps.warn(`could not send a push notification for a failing job (needs bb 0.48.1 or newer with Push notifications on): ${message}`);
      }
    }
  }

  /**
   * Queues one count, with the Macs that were asked and did not answer;
   * counts are handled one at a time, in order. Never rejects.
   */
  function observe(failing: readonly FailingEntry[], unanswered: readonly string[] = []): Promise<void> {
    chain = chain
      .then(() => step(failing, unanswered))
      .catch((error: unknown) => deps.warn(`could not check for newly failing jobs: ${String(error)}`));
    return chain;
  }

  return {
    observe,
    /** Stops sending and recording; a count already queued does nothing. */
    dispose(): void {
      disposed = true;
    },
  };
}
