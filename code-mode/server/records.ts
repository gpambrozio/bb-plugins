// The sticky record, kept on each thread as this plugin's metadata (shared/record.ts) and cached in
// memory: a record never changes once written, so the cache needs no invalidation, and the resolver,
// which bb calls before every start, resume, fork and turn, answers from memory after the first read.
//
// `decideOnce` serializes the deciders of one thread, so the dispatch hook and the resolver can never
// write two different answers for it: whichever comes second finds the first one's record.
import { METADATA_BATCH } from "../shared/contract";
import { RECORD_KEY, recordSchema, type CodeModeRecord } from "../shared/record";

export interface RecordsDeps {
  /** The thread's metadata from this plugin, or null when it has none. */
  read(threadId: string): Promise<Record<string, unknown> | null>;
  /** The same for up to 200 threads; a thread with no metadata is missing from the map. */
  readMany(threadIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
  write(threadId: string, record: CodeModeRecord): Promise<void>;
  /** A record was written: tell the app. */
  changed(threadId: string): void;
  now(): number;
  log: { warn(message: string): void };
}

export type Decided = { record: CodeModeRecord; store: boolean } | { record: null };

export function createRecords(deps: RecordsDeps) {
  /** A record read or written, or null for a thread that has none and never will (it predates the plugin). */
  const known = new Map<string, CodeModeRecord | null>();
  const deciding = new Map<string, Promise<CodeModeRecord | null>>();

  async function readStored(threadId: string): Promise<CodeModeRecord | null> {
    const metadata = await deps.read(threadId);
    const value = metadata?.[RECORD_KEY];
    if (value === undefined) return null;
    const parsed = recordSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    // Not ours to fix: a broken record must never turn into a different answer.
    deps.log.warn(`Thread ${threadId} has an unreadable Code Mode record; treating it as off.`);
    return { codeMode: "off", reason: "unreadable record", decidedAt: 0 };
  }

  /** The thread's record, or null when it has none (yet). */
  async function get(threadId: string): Promise<CodeModeRecord | null> {
    if (known.has(threadId)) return known.get(threadId) ?? null;
    const pending = deciding.get(threadId);
    if (pending) return pending;
    const stored = await readStored(threadId);
    // Cache only a hit: a miss may be decided a moment later.
    if (stored) known.set(threadId, stored);
    return stored;
  }

  /**
   * The thread's record; when it has none, runs `decider` once and keeps what it answers. A decider
   * answers `{ record: null }` for a thread the plugin must leave alone, `store: false` to remember an
   * answer for this load only.
   */
  function decideOnce(threadId: string, decider: () => Promise<Decided>): Promise<CodeModeRecord | null> {
    if (known.has(threadId)) return Promise.resolve(known.get(threadId) ?? null);
    const pending = deciding.get(threadId);
    if (pending) return pending;
    const run = (async () => {
      const stored = await readStored(threadId);
      if (stored) {
        known.set(threadId, stored);
        return stored;
      }
      const decided = await decider();
      if (decided.record === null) {
        known.set(threadId, null);
        return null;
      }
      if (decided.store) {
        await deps.write(threadId, decided.record);
        deps.changed(threadId);
      }
      known.set(threadId, decided.record);
      return decided.record;
    })().finally(() => deciding.delete(threadId));
    deciding.set(threadId, run);
    return run;
  }

  function make(codeMode: CodeModeRecord["codeMode"], reason: string): CodeModeRecord {
    return { codeMode, reason, decidedAt: deps.now() };
  }

  /** Many threads at once, for the app's badges: one batch read for those not cached yet. */
  async function getMany(threadIds: readonly string[]): Promise<Map<string, CodeModeRecord | null>> {
    const answer = new Map<string, CodeModeRecord | null>();
    const missing: string[] = [];
    for (const threadId of threadIds) {
      if (known.has(threadId)) answer.set(threadId, known.get(threadId) ?? null);
      else missing.push(threadId);
    }
    if (missing.length > 0) {
      const rows = new Map<string, Record<string, unknown>>();
      for (let at = 0; at < missing.length; at += METADATA_BATCH) {
        for (const [threadId, metadata] of await deps.readMany(missing.slice(at, at + METADATA_BATCH))) rows.set(threadId, metadata);
      }
      for (const threadId of missing) {
        const value = rows.get(threadId)?.[RECORD_KEY];
        const parsed = value === undefined ? null : recordSchema.safeParse(value);
        const record = parsed === null ? null : parsed.success ? parsed.data : null;
        if (record) known.set(threadId, record);
        answer.set(threadId, record);
      }
    }
    return answer;
  }

  return { get, getMany, decideOnce, make };
}

export type Records = ReturnType<typeof createRecords>;
