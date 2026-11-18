/**
 * The run log the History page and `bb dream history` read: one kv row per dream, with its full
 * summary, newest first. Rows are small (a summary is a few KB), one per key, and the oldest go past
 * `KEEP_RUNS`.
 */
import type { RunRecord } from "../shared/contract-types";

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export const KEEP_RUNS = 300;
const PREFIX = "run:";
/** Summaries past this are cut, to stay well inside kv's 256 KB a value. */
const MAX_SUMMARY = 64 * 1024;

function keyOf(record: Pick<RunRecord, "startedAt" | "runId">): string {
  return `${PREFIX}${String(record.startedAt).padStart(15, "0")}-${record.runId}`;
}

export function createHistory(kv: KvLike) {
  return {
    async put(record: RunRecord): Promise<void> {
      const summary = record.summary !== null && record.summary.length > MAX_SUMMARY ? `${record.summary.slice(0, MAX_SUMMARY)}\n…` : record.summary;
      await kv.set(keyOf(record), { ...record, summary });
    },

    async list(limit = 50, projectId?: string): Promise<RunRecord[]> {
      const keys = (await kv.list(PREFIX)).sort().reverse();
      const records: RunRecord[] = [];
      for (const key of keys) {
        if (records.length >= limit) break;
        const record = await kv.get<RunRecord>(key);
        if (record && (projectId === undefined || record.projectId === projectId)) records.push(record);
      }
      return records;
    },

    async get(runId: string): Promise<RunRecord | null> {
      const key = (await kv.list(PREFIX)).find((candidate) => candidate.endsWith(`-${runId}`));
      return key ? ((await kv.get<RunRecord>(key)) ?? null) : null;
    },

    async prune(): Promise<void> {
      const keys = (await kv.list(PREFIX)).sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_RUNS))) await kv.delete(key);
    },
  };
}

export type History = ReturnType<typeof createHistory>;
