/**
 * Each thread's past sentences, for its Herald panel. One kv row per thread
 * (`history:<threadId>`), newest first, capped at `HISTORY_LIMIT` so a row
 * stays far under kv's 256 KB. Writes to one thread are chained so two
 * sentences a moment apart cannot lose each other; a failed write is logged
 * and the next one tries again from storage.
 *
 * The Herald page lists the newest sentences of every thread: `recent` lists
 * the rows by their prefix and merges them, so there is no second index to
 * keep in step with the rows.
 */
import { HISTORY_HEADLINE_MAX, HISTORY_LIMIT, HistoryItemSchema, MAX_SPEECH_CHARS, type HistoryItem } from "../shared/herald";
import type { Log } from "./ports";

export const HISTORY_PREFIX = "history:";

/** The part of `bb.storage.kv` the history uses. */
export interface HistoryKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** A past sentence with the thread it belongs to. */
export type ThreadHistoryItem = HistoryItem & { threadId: string };

export class SentenceHistory {
  private readonly chains = new Map<string, Promise<void>>();
  /** Bumped by every write issued, so a scan knows whether it can still be shared. */
  private writes = 0;
  /** The scan in flight, shared by every caller that comes before the next write. */
  private scan: { writes: number; items: Promise<ThreadHistoryItem[]> } | null = null;

  constructor(
    private readonly kv: HistoryKv,
    private readonly log: Log,
  ) {}

  /**
   * Puts `item` first, replacing an older item for the same event. Never
   * rejects. Its texts are cut first: a headline can be an error of
   * kilobytes, and fifty of those would pass kv's 256 KB row.
   */
  append(threadId: string, item: HistoryItem): void {
    const bounded: HistoryItem = { ...item, headline: cut(item.headline, HISTORY_HEADLINE_MAX), text: cut(item.text, MAX_SPEECH_CHARS) };
    this.enqueue(threadId, async () => {
      const current = await this.list(threadId);
      const next = [bounded, ...current.filter((existing) => existing.eventId !== bounded.eventId)].slice(0, HISTORY_LIMIT);
      await this.kv.set(`${HISTORY_PREFIX}${threadId}`, next);
    });
  }

  /** Newest first; empty for a thread Herald has nothing on, or a row it cannot read. */
  async list(threadId: string): Promise<HistoryItem[]> {
    const raw = await this.kv.get<unknown>(`${HISTORY_PREFIX}${threadId}`);
    if (!Array.isArray(raw)) return [];
    const items: HistoryItem[] = [];
    for (const candidate of raw) {
      const parsed = HistoryItemSchema.safeParse(candidate);
      if (parsed.success) items.push(parsed.data);
    }
    return items;
  }

  /**
   * The newest `limit` sentences across every thread, newest first. Waits for
   * the writes issued so far, so a sentence the app was just told about is in
   * the answer. Callers at once share one scan of every row — several open
   * pages hear the same nudge — unless a write was issued since it started.
   */
  async recent(limit: number): Promise<ThreadHistoryItem[]> {
    return (await this.sharedScan()).slice(0, limit);
  }

  private sharedScan(): Promise<ThreadHistoryItem[]> {
    if (this.scan !== null && this.scan.writes === this.writes) return this.scan.items;
    const scan = { writes: this.writes, items: this.flush().then(() => this.scanAll()) };
    this.scan = scan;
    const done = () => {
      if (this.scan === scan) this.scan = null;
    };
    scan.items.then(done, done);
    return scan.items;
  }

  private async scanAll(): Promise<ThreadHistoryItem[]> {
    const keys = await this.kv.list(HISTORY_PREFIX);
    const rows = await Promise.all(
      keys.map(async (key) => {
        const threadId = key.slice(HISTORY_PREFIX.length);
        return (await this.list(threadId)).map((item) => ({ ...item, threadId }));
      }),
    );
    return rows
      .flat()
      .sort((a, b) => timeOf(b) - timeOf(a) || b.eventId.localeCompare(a.eventId));
  }

  /** For a deleted thread. */
  remove(threadId: string): Promise<void> {
    this.enqueue(threadId, () => this.kv.delete(`${HISTORY_PREFIX}${threadId}`));
    return this.flush();
  }

  /** Resolves once every write issued so far has landed; for tests and unload. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private enqueue(threadId: string, work: () => Promise<void>): void {
    this.writes += 1;
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      this.log.error(`Could not save thread ${threadId}'s sentence history: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.chains.set(threadId, next);
  }
}

/** An unreadable time sorts last rather than scrambling the order. */
function timeOf(item: HistoryItem): number {
  const at = Date.parse(item.createdAt);
  return Number.isFinite(at) ? at : 0;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
