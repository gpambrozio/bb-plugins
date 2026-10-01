/**
 * The store's entries in `bb.storage.kv`, one row per thread under `entry:`.
 *
 * One row each rather than one array, because a value is capped at 256 KB and
 * a user with a few hundred unattended threads would pass that. A write
 * changes only the rows whose entry changed and deletes the rows of threads no
 * longer in the map, so mirroring the whole map on every change stays cheap.
 */
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

import type { AttentionEntry } from "../shared/herald";
import type { StoreBackend } from "./store";

export const ENTRY_PREFIX = "entry:";

export function kvBackend(kv: PluginKvStorage): StoreBackend {
  /** What each row holds now, as JSON, so a write can skip the rows that did not change. */
  const written = new Map<string, string>();

  return {
    async read() {
      const keys = await kv.list(ENTRY_PREFIX);
      const values = await Promise.all(keys.map((key) => kv.get<unknown>(key)));
      const entries: unknown[] = [];
      keys.forEach((key, index) => {
        const value = values[index];
        if (value === undefined) return;
        written.set(key, JSON.stringify(value));
        entries.push(value);
      });
      return entries;
    },
    async write(entries: readonly AttentionEntry[]) {
      const present = new Set<string>();
      for (const entry of entries) {
        const key = `${ENTRY_PREFIX}${entry.threadId}`;
        present.add(key);
        const json = JSON.stringify(entry);
        if (written.get(key) === json) continue;
        await kv.set(key, entry);
        written.set(key, json);
      }
      for (const key of [...written.keys()]) {
        if (present.has(key)) continue;
        await kv.delete(key);
        written.delete(key);
      }
    },
  };
}
