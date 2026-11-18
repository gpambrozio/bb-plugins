/**
 * What the plugin itself owns, as opposed to what the captain edits in settings: which thread is the
 * first mate, which watches are switched off, which threads autocompact last compacted, and where the
 * first-run guide stands. Kept in `bb.storage.kv`.
 *
 * The stored id is the only way the first mate is found. Nothing looks it up by metadata or title,
 * so a released first mate stays released.
 */
import type { PluginKvStorage } from "@get-bb/plugin-sdk";

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
 * Where the first-run guide stands for this install (`intro.ts`): `offered` while it may still be shown,
 * `done` once a first mate has been launched or adopted, `dismissed` after "Don't ask again", and
 * `settled` for an install that already had a home or a first mate when the guide was first considered.
 */
export type IntroState = "offered" | "done" | "dismissed" | "settled";

const INTRO_STATES: readonly IntroState[] = ["offered", "done", "dismissed", "settled"];

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
  /** Whether anything but the guide's own state is stored: an install that has been used. */
  hasRecords(): Promise<boolean>;
  /** Null until the guide has been considered for this install. */
  introState(): Promise<IntroState | null>;
  setIntroState(state: IntroState): Promise<void>;
}

const MATE_THREAD_ID = "mateThreadId";
const DISABLED_WATCHES = "disabledWatches";
/** One key per thread, so a large crew never meets kv's 256 KB limit on one value. */
const COMPACTION_PREFIX = "autoCompaction:";
const INTRO_STATE = "introState";

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
    async hasRecords() {
      return (await kv.list()).some((key) => key !== INTRO_STATE);
    },
    async introState() {
      const state = await kv.get<unknown>(INTRO_STATE);
      return INTRO_STATES.find((known) => known === state) ?? null;
    },
    async setIntroState(state) {
      await kv.set(INTRO_STATE, state);
    },
  };
}
