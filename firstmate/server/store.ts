/**
 * What the plugin itself owns, as opposed to what the captain edits in settings: which thread is the
 * first mate, and which watches are switched off. Kept in `bb.storage.kv`.
 *
 * The stored id is the only way the first mate is found. Nothing looks it up by metadata or title,
 * so a released first mate stays released.
 */
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

export interface Store {
  mateThreadId(): Promise<string | null>;
  /** `null` forgets the first mate. */
  setMateThreadId(id: string | null): Promise<void>;
  disabledWatches(): Promise<string[]>;
  setDisabledWatches(names: string[]): Promise<void>;
}

const MATE_THREAD_ID = "mateThreadId";
const DISABLED_WATCHES = "disabledWatches";

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
  };
}
