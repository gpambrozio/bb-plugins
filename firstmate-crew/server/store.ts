/**
 * What the plugin itself owns, as opposed to what the captain edits in settings: which thread is the
 * first mate, which watches are switched off, which threads autocompact last compacted, and the bb
 * notification level FirstMate replaced on the first mate. Kept in `bb.storage.kv`.
 *
 * The stored id is the only way the first mate is found. Nothing looks it up by metadata or title,
 * so a released first mate stays released.
 */
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

import type { NotificationLevel } from "./ports";

/**
 * Autocompact's record of compacting one thread: `afterSeq` is the `turn/completed` event that began the
 * idle stretch it compacted, `ok` whether bb accepted the request (true from before the request is sent
 * until bb refuses it), `at` when (epoch milliseconds).
 */
export interface CompactionMark {
  afterSeq: number;
  ok: boolean;
  at: number;
}

/**
 * FirstMate sends the first mate's notifications itself (`mate-notify.ts`): `threadId` is the thread whose
 * bb notification level it changed, and `previous` the level that thread had of its own before.
 */
export interface NotificationHold {
  threadId: string;
  previous: NotificationLevel;
}

export interface Store {
  mateThreadId(): Promise<string | null>;
  /** `null` forgets the first mate. */
  setMateThreadId(id: string | null): Promise<void>;
  disabledWatches(): Promise<string[]>;
  setDisabledWatches(names: string[]): Promise<void>;
  /** Autocompact's mark for one thread, or null when it has none. */
  compactionMark(threadId: string): Promise<CompactionMark | null>;
  setCompactionMark(threadId: string, mark: CompactionMark): Promise<void>;
  deleteCompactionMark(threadId: string): Promise<void>;
  /** The threads that have a mark. */
  compactionMarkIds(): Promise<string[]>;
  /** The first mate's notification level FirstMate replaced, or null when it has replaced none. */
  notificationHold(): Promise<NotificationHold | null>;
  /** `null` forgets it, once the level is restored. */
  setNotificationHold(hold: NotificationHold | null): Promise<void>;
}

const MATE_THREAD_ID = "mateThreadId";
const DISABLED_WATCHES = "disabledWatches";
const NOTIFICATION_HOLD = "mateNotificationHold";
const LEVELS: readonly string[] = ["inherit", "all", "input-only", "muted"];
/** One key per thread, so a large crew never meets kv's 256 KB limit on one value. */
const COMPACTION_PREFIX = "autoCompaction:";

function isMark(value: unknown): value is CompactionMark {
  if (typeof value !== "object" || value === null) return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.afterSeq === "number" && typeof mark.ok === "boolean" && typeof mark.at === "number";
}

function isHold(value: unknown): value is NotificationHold {
  if (typeof value !== "object" || value === null) return false;
  const hold = value as Record<string, unknown>;
  return typeof hold.threadId === "string" && hold.threadId !== "" && typeof hold.previous === "string" && LEVELS.includes(hold.previous);
}

export function createStore(kv: PluginKvStorage): Store {
  return {
    async mateThreadId() {
      const id = await kv.get<unknown>(MATE_THREAD_ID);
      return typeof id === "string" && id !== "" ? id : null;
    },
    async setMateThreadId(id) {
      if (id === null) await kv.delete(MATE_THREAD_ID);
      else await kv.set(MATE_THREAD_ID, id);
    },
    async disabledWatches() {
      const names = await kv.get<unknown>(DISABLED_WATCHES);
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
    },
    async setDisabledWatches(names) {
      await kv.set(DISABLED_WATCHES, [...new Set(names)]);
    },
    async compactionMark(threadId) {
      const mark = await kv.get<unknown>(COMPACTION_PREFIX + threadId);
      return isMark(mark) ? { afterSeq: mark.afterSeq, ok: mark.ok, at: mark.at } : null;
    },
    async setCompactionMark(threadId, mark) {
      await kv.set(COMPACTION_PREFIX + threadId, mark);
    },
    async deleteCompactionMark(threadId) {
      await kv.delete(COMPACTION_PREFIX + threadId);
    },
    async compactionMarkIds() {
      return (await kv.list(COMPACTION_PREFIX)).map((key) => key.slice(COMPACTION_PREFIX.length));
    },
    async notificationHold() {
      const hold = await kv.get<unknown>(NOTIFICATION_HOLD);
      return isHold(hold) ? { threadId: hold.threadId, previous: hold.previous } : null;
    },
    async setNotificationHold(hold) {
      if (hold === null) await kv.delete(NOTIFICATION_HOLD);
      else await kv.set(NOTIFICATION_HOLD, hold);
    },
  };
}
