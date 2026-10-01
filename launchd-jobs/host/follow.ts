import { basename, dirname } from "node:path";

import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from "@get-bb/plugin-sdk";

/**
 * Follow mode: a native watch on the directory holding a job's log, which
 * signals the server each time the log changes. The app then reads what was
 * appended (`log` with `from`), so the pane shows output as the job writes it.
 *
 * A follow lasts `FOLLOW_TTL_MS` after the last `follow` call and then ends by
 * itself. The app renews it while the pane is following; a window that closes,
 * crashes or loses its connection simply stops renewing. Nothing else holds the
 * watch, and a held watch is what keeps the host worker alive.
 */
export const FOLLOW_TTL_MS = 45_000;

interface Subscription {
  dispose(): Promise<void>;
}

/** What one `follow` call lends: the watcher and the signal, from its handler context. */
export interface FollowContext {
  watch(options: ExperimentalHostWatchOptions, listener: ExperimentalHostWatchListener): Promise<Subscription>;
  changed(): Promise<void>;
}

interface Follow {
  logPath: string;
  subscription: Subscription | null;
  timer: ReturnType<typeof setTimeout>;
}

export function createLogFollows(warn: (message: string) => void) {
  const follows = new Map<string, Follow>();

  function end(id: string, entry: Follow): void {
    if (follows.get(id) === entry) follows.delete(id);
    clearTimeout(entry.timer);
    const subscription = entry.subscription;
    entry.subscription = null;
    if (subscription !== null) {
      void subscription.dispose().catch((error: unknown) => warn(`could not stop watching the log of ${id}: ${String(error)}`));
    }
  }

  function expireLater(id: string, entry: () => Follow): ReturnType<typeof setTimeout> {
    return setTimeout(() => end(id, entry()), FOLLOW_TTL_MS);
  }

  return {
    /** Starts following `logPath` for job `id`, or extends the follow already running. */
    async follow(id: string, logPath: string, context: FollowContext): Promise<number> {
      let existing = follows.get(id);
      // An edit can move a job's files; a renewal for the new path starts over.
      if (existing !== undefined && existing.logPath !== logPath) {
        end(id, existing);
        existing = undefined;
      }
      if (existing !== undefined) {
        const renewed = existing;
        clearTimeout(renewed.timer);
        renewed.timer = expireLater(id, () => renewed);
        return FOLLOW_TTL_MS;
      }
      const file = basename(logPath);
      const entry: Follow = { logPath, subscription: null, timer: expireLater(id, () => entry) };
      follows.set(id, entry);
      let subscription: Subscription;
      try {
        subscription = await context.watch({ rootPath: dirname(logPath), debounceMs: 100, maxWaitMs: 500 }, (event) => {
          if (event.kind === "watch-error") {
            warn(`watching the log of ${id} failed: ${event.message}`);
            return;
          }
          // The log itself, or its rotation (`<slug>.log.1`) moving it aside.
          const touched =
            event.kind === "rescan-required" ||
            event.changes.some((change) => basename(change.path).startsWith(file));
          if (touched) {
            void context.changed().catch((error: unknown) => warn(`could not signal a change to ${id}: ${String(error)}`));
          }
        });
      } catch (error) {
        end(id, entry);
        throw error;
      }
      entry.subscription = subscription;
      // An unfollow, or the expiry, landed while the watch was starting.
      if (follows.get(id) !== entry) end(id, entry);
      return FOLLOW_TTL_MS;
    },

    unfollow(id: string): void {
      const entry = follows.get(id);
      if (entry !== undefined) end(id, entry);
    },

    following(): string[] {
      return [...follows.keys()];
    },

    dispose(): void {
      for (const [id, entry] of follows) end(id, entry);
    },
  };
}
