/**
 * One entry per thread: the most recent reason it is waiting on the user, and
 * the summary for it. Newer events replace older ones for the same thread — a
 * thread has one composer and one thing it is waiting for.
 *
 * bb's own unread and pending-interaction state stays the authority on *who*
 * is waiting; this store only explains *why*. Entries are removed when the
 * events show the thread moving on (a new turn, an archive, a delete), and by
 * `Liveness` when the thread turns out to be gone, read, or answered. There is
 * no age limit: a thread that asked a question a week ago is still waiting.
 *
 * Mirrored to the plugin's storage so a reload does not lose the summaries
 * already written; a summary still pending at load time is marked failed,
 * because the helper that was writing it died with the old instance.
 */
import { AttentionEntrySchema, type AttentionEntry, type SummaryState } from "../shared/herald";
import type { Log } from "./ports";
import { fallbackSpeech } from "./timeline";

/** Where the entries are kept between loads. The map is the truth; this mirrors it. */
export interface StoreBackend {
  read(): Promise<unknown[]>;
  write(entries: readonly AttentionEntry[]): Promise<void>;
}

export class AttentionStore {
  private readonly entries = new Map<string, AttentionEntry>();
  private writes: Promise<void> = Promise.resolve();
  /**
   * Threads changed since storage was last read. A read may run while the
   * plugin is already answering events, and whatever arrived live is newer
   * than anything stored. Cleared once each read is done.
   */
  private readonly touched = new Set<string>();
  /**
   * Set while `load()` is reading. Writes queued in that window wait for it:
   * otherwise one would mirror a map that has not been merged yet, erasing the
   * very rows being read.
   */
  private loading: Promise<void> | null = null;
  /**
   * Conditional removals that arrived before the entry they test had been
   * read. `remove` can mark its thread `touched` unconditionally; `removeIf`
   * cannot, because its test needs the very entry still in storage. So the
   * test is kept here and applied to that entry as it is merged — otherwise an
   * interaction answered during the read is silently restored by the merge.
   */
  private readonly deferredRemovals = new Map<string, Array<(entry: AttentionEntry) => boolean>>();

  /** Set once the plugin unloads: storage is the replacement's from then on. */
  private closed = false;

  /** `backend === null` keeps everything in memory. */
  constructor(
    private readonly backend: StoreBackend | null,
    private readonly log: Log,
  ) {}

  /**
   * Brings the map in line with storage again, for when another instance of
   * the plugin wrote to it after this one loaded — the instance a reload
   * replaced, flushing its last writes. Same rules as `load`: whatever this
   * instance changed itself since it last read storage stays as it is.
   */
  reconcile(): Promise<void> {
    return this.load();
  }

  async load(): Promise<void> {
    const backend = this.backend;
    if (backend === null) return;
    // After any write already under way: a read in the middle of one mixes
    // the two, and the kv backend's bookkeeping then deletes rows the read
    // just found. Writes queued from here on wait for the read instead.
    const run = this.writes.then(() => this.read(backend));
    // Never rejects, so a failed read cannot wedge the write chain behind it.
    this.loading = run.catch(() => {});
    try {
      await run;
    } finally {
      this.loading = null;
    }
  }

  private async read(backend: StoreBackend): Promise<void> {
    const stored = await backend.read();
    const seen = new Set<string>();
    for (const item of stored) {
      const parsed = AttentionEntrySchema.safeParse(item);
      if (!parsed.success) {
        this.log.warn(`Dropping an unreadable saved entry: ${parsed.error.message}`);
        continue;
      }
      const entry = parsed.data;
      seen.add(entry.threadId);
      // Never undo a live upsert or removal that landed since the last read.
      if (this.touched.has(entry.threadId)) continue;
      const held = this.deferredRemovals.get(entry.threadId);
      if (held !== undefined && held.some((matches) => matches(entry))) {
        continue;
      }
      this.entries.set(
        entry.threadId,
        entry.summary.status === "pending"
          ? {
              ...entry,
              summary: {
                status: "failed",
                error: "The plugin restarted before the summary was written.",
                fallback: fallbackSpeech(entry),
              },
            }
          : entry,
      );
    }
    // An entry held from an earlier read that storage no longer has was
    // removed since by the instance that wrote it.
    for (const threadId of [...this.entries.keys()]) {
      if (!seen.has(threadId) && !this.touched.has(threadId)) {
        this.entries.delete(threadId);
      }
    }
    // Mirror the merged map — rows dropped above, rows this instance changed
    // while the other one was writing. Unchanged rows cost nothing.
    this.persist();
    this.touched.clear();
    this.deferredRemovals.clear();
  }

  list(): AttentionEntry[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(threadId: string): AttentionEntry | null {
    return this.entries.get(threadId) ?? null;
  }

  upsert(entry: AttentionEntry): void {
    this.touched.add(entry.threadId);
    this.entries.set(entry.threadId, entry);
    this.persist();
  }

  /**
   * Applies a summary only if the thread is still waiting on the same event.
   * A helper that finishes after the user has already moved on — or after a
   * newer event replaced this one — must not overwrite what is there now.
   */
  updateSummary(threadId: string, eventId: string, summary: SummaryState): boolean {
    const current = this.entries.get(threadId);
    if (current === undefined || current.eventId !== eventId) return false;
    this.entries.set(threadId, { ...current, summary });
    this.persist();
    return true;
  }

  remove(threadId: string): AttentionEntry | null {
    this.touched.add(threadId);
    const current = this.entries.get(threadId) ?? null;
    if (current !== null) {
      this.entries.delete(threadId);
      this.persist();
    }
    return current;
  }

  removeIf(threadId: string, predicate: (entry: AttentionEntry) => boolean): boolean {
    const current = this.entries.get(threadId);
    if (current === undefined) {
      // Absent, or simply not read yet. While loading it is the second, so the
      // test is held for the merge rather than thrown away.
      if (this.loading !== null) {
        const held = this.deferredRemovals.get(threadId) ?? [];
        held.push(predicate);
        this.deferredRemovals.set(threadId, held);
      }
      return false;
    }
    if (!predicate(current)) return false;
    this.touched.add(threadId);
    this.entries.delete(threadId);
    this.persist();
    return true;
  }

  /**
   * Stops writing to storage; on unload, after `flush`. A summary still
   * settling after that changes only this instance's memory, never what the
   * replacement has read.
   */
  close(): void {
    this.closed = true;
  }

  /** Resolves once every write issued so far has landed; for tests and unload. */
  flush(): Promise<void> {
    return this.writes;
  }

  /**
   * Writes are chained so two events a millisecond apart cannot interleave. A
   * failed write is reported and never thrown: the store in memory is still
   * right, and the next write tries again.
   */
  private persist(): void {
    const backend = this.backend;
    if (backend === null || this.closed) return;
    const loaded = this.loading ?? Promise.resolve();
    this.writes = this.writes
      .then(() => loaded)
      // Read here rather than at the call, so a write that waited for `load()`
      // mirrors the merged map rather than the map as it stood when it was
      // queued. Storage mirrors the map, it is not a log, so writing the latest
      // state is always the right thing.
      .then(() => backend.write([...this.entries.values()]))
      .catch((error: unknown) => {
        this.log.error(`Could not save Herald's entries: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}
