/**
 * What the plugin itself owns, as opposed to what the captain edits in settings: which thread is the
 * first mate, which watches are switched off, and which threads autocompact last compacted. Kept in
 * `bb.storage.kv`.
 *
 * The stored id is the only way the first mate is found. Nothing looks it up by metadata or title,
 * so a released first mate stays released.
 */
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

/**
 * Autocompact's record of compacting one thread: `afterSeq` is the `turn/completed` event that began the
 * idle stretch it compacted, `ok` whether bb accepted the request, `at` when (epoch milliseconds).
 */
export interface CompactionMark {
  afterSeq: number;
  ok: boolean;
  at: number;
}

export interface Store {
  mateThreadId(): Promise<string | null>;
  /** `null` forgets the first mate. */
  setMateThreadId(id: string | null): Promise<void>;
  disabledWatches(): Promise<string[]>;
  setDisabledWatches(names: string[]): Promise<void>;
  /** Autocompact's marks, by thread id. */
  compactions(): Promise<Record<string, CompactionMark>>;
  setCompactions(marks: Record<string, CompactionMark>): Promise<void>;
}

const MATE_THREAD_ID = "mateThreadId";
const DISABLED_WATCHES = "disabledWatches";
const COMPACTIONS = "autoCompactions";

function isMark(value: unknown): value is CompactionMark {
  if (typeof value !== "object" || value === null) return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.afterSeq === "number" && typeof mark.ok === "boolean" && typeof mark.at === "number";
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
    async compactions() {
      const stored = await kv.get<unknown>(COMPACTIONS);
      if (typeof stored !== "object" || stored === null) return {};
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, CompactionMark] => isMark(entry[1])));
    },
    async setCompactions(marks) {
      if (Object.keys(marks).length === 0) await kv.delete(COMPACTIONS);
      else await kv.set(COMPACTIONS, marks);
    },
  };
}
