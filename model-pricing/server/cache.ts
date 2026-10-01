/**
 * One `bb.storage.kv` value per upstream (`cache/<source>`), holding that
 * source's rows, when they were fetched, and its ETag.
 *
 * This is the plugin's own store rather than a setting because nobody edits it
 * and the handler has to *read* it. What it is not is a second copy of the
 * user's choices: which providers to fetch arrives in the RPC, so nothing here
 * needs to know what the user picked.
 *
 * **It caches normalized rows, never the raw document.** models.dev answers
 * with 4.7 MB; the rows this plugin keeps out of it are a few tens of KB. That
 * one decision is what keeps both the stored value and the RPC payload small —
 * and under kv's 256 KB per value. A write that is refused anyway (too large,
 * storage down) is logged and the rows stay in memory.
 *
 * `store === null` keeps everything in memory and is the seam the handler
 * tests use.
 */
import { PriceRowSchema, type PriceRow } from "../shared/pricing";
import type { SourceId } from "../shared/providers";

export interface CacheEntry {
  rows: PriceRow[];
  /** Epoch ms of the fetch these rows came from. */
  fetchedAt: number;
  /** The upstream's ETag, so the next fetch can ask for a 304. */
  etag: string | null;
}

/** The slice of `bb.storage.kv` the cache uses. */
export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export type Warn = (message: string) => void;

export function cacheKey(source: SourceId): string {
  return `cache/${source}`;
}

export class PricingCache {
  private readonly entries = new Map<SourceId, CacheEntry>();
  /** Sources already looked for in the store, hit or miss, so a miss is read once. */
  private readonly loaded = new Set<SourceId>();
  /**
   * Writes are chained rather than fired in parallel, so the same source
   * refreshed twice in a row lands in the order it was fetched.
   */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: CacheStore | null,
    private readonly warn: Warn = (message) => console.error(message),
  ) {}

  /**
   * A missing, unreadable or invalid value is a cache miss, reported and
   * otherwise ignored. Throwing here would turn a corrupt cache into a plugin
   * that can never load prices again, when refetching would have fixed it.
   */
  async read(source: SourceId): Promise<CacheEntry | null> {
    const cached = this.entries.get(source);
    if (cached !== undefined) return cached;

    if (this.store === null || this.loaded.has(source)) return null;
    this.loaded.add(source);

    let raw: unknown;
    try {
      raw = await this.store.get(cacheKey(source));
    } catch (error) {
      this.warn(`could not read the ${source} cache: ${errorText(error)}`);
      return null;
    }
    if (raw === undefined || raw === null) return null;

    const entry = parseEntry(raw, source, this.warn);
    if (entry === null) return null;
    // A write that landed while this read was in flight is newer; keep it.
    if (!this.entries.has(source)) this.entries.set(source, entry);
    return this.entries.get(source) ?? entry;
  }

  /**
   * Memory is updated synchronously and the store follows. A failed write is
   * logged, never thrown: the rows in hand are still good, and the next
   * refresh retries.
   */
  write(source: SourceId, entry: CacheEntry): void {
    this.entries.set(source, entry);
    this.loaded.add(source);

    const store = this.store;
    if (store === null) return;
    this.writes = this.writes.then(async () => {
      try {
        await store.set(cacheKey(source), entry);
      } catch (error) {
        this.warn(`could not store the ${source} cache: ${errorText(error)}`);
      }
    });
  }

  /**
   * Awaited on dispose, so a reload does not drop a write.
   *
   * Drains rather than returning the chain as it stands: a `load` still
   * resolving while the plugin is torn down can queue a write *after* the
   * dispose handler has awaited, and returning `this.writes` once would not
   * cover it.
   */
  async flush(): Promise<void> {
    let pending = this.writes;
    // Each await lets anything queued during the previous one settle too.
    for (;;) {
      await pending;
      if (this.writes === pending) return;
      pending = this.writes;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEntry(json: unknown, source: SourceId, warn: Warn): CacheEntry | null {
  if (typeof json !== "object" || json === null) {
    warn(`the ${source} cache is not an object, refetching.`);
    return null;
  }
  const { rows, fetchedAt, etag } = json as Record<string, unknown>;
  if (!Array.isArray(rows) || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) {
    warn(`the ${source} cache is missing its rows or fetch time, refetching.`);
    return null;
  }

  const parsed = PriceRowSchema.array().safeParse(rows);
  if (!parsed.success) {
    warn(`the ${source} cache does not match the current row shape, refetching.`);
    return null;
  }
  return { rows: parsed.data, fetchedAt, etag: typeof etag === "string" ? etag : null };
}

/** How long rows are reused before a load refetches. Refresh ignores it. */
export const TTL_MS = 12 * 60 * 60 * 1000;

export function isFresh(entry: CacheEntry, now: number = Date.now()): boolean {
  return now - entry.fetchedAt < TTL_MS;
}
