import { describe, expect, it, vi } from "vitest";

import { cacheKey, isFresh, PricingCache, TTL_MS, type CacheEntry, type CacheStore } from "./cache";
import type { PriceRow } from "../shared/pricing";

function row(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    providerId: "anthropic",
    modelId: "claude-opus-5",
    name: "Claude Opus 5",
    contextTokens: 1_000_000,
    outputTokens: 128_000,
    inputCost: 5,
    outputCost: 25,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    temperature: false,
    releaseDate: "2026-07-24",
    ...overrides,
  };
}

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return { rows: [row()], fetchedAt: Date.now(), etag: '"abc123"', ...overrides };
}

/** `bb.storage.kv`'s shape over a Map, with every call counted. */
function memoryStore(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const store = {
    values,
    get: vi.fn(async (key: string) => structuredClone(values.get(key))),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
  } satisfies CacheStore & { values: Map<string, unknown> };
  return store;
}

describe("PricingCache without a store", () => {
  it("keeps entries in memory", async () => {
    const cache = new PricingCache(null);
    expect(await cache.read("models-dev")).toBeNull();

    cache.write("models-dev", entry());
    expect((await cache.read("models-dev"))?.rows).toHaveLength(1);
    await cache.flush();
  });
});

describe("PricingCache on kv", () => {
  it("writes one value per source and reads it back in a fresh cache", async () => {
    const store = memoryStore();
    const writer = new PricingCache(store);
    writer.write("models-dev", entry({ fetchedAt: 1_700_000_000_000 }));
    writer.write("openrouter", entry({ rows: [row({ providerId: "openrouter" })], etag: null }));
    await writer.flush();

    expect((store.values.get(cacheKey("models-dev")) as CacheEntry).etag).toBe('"abc123"');

    const reader = new PricingCache(store);
    const modelsDev = await reader.read("models-dev");
    expect(modelsDev?.fetchedAt).toBe(1_700_000_000_000);
    expect(modelsDev?.rows[0]?.name).toBe("Claude Opus 5");
    expect((await reader.read("openrouter"))?.etag).toBeNull();
  });

  it("stores writes to one source in the order they were made", async () => {
    const store = memoryStore();
    const cache = new PricingCache(store);
    cache.write("models-dev", entry({ rows: [row({ modelId: "first" })] }));
    cache.write("models-dev", entry({ rows: [row({ modelId: "second" })] }));
    cache.write("models-dev", entry({ rows: [row({ modelId: "third" })] }));
    await cache.flush();

    const stored = store.values.get(cacheKey("models-dev")) as CacheEntry;
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.modelId).toBe("third");
  });

  it("treats a missing value as a miss, quietly", async () => {
    const warn = vi.fn();
    expect(await new PricingCache(memoryStore(), warn).read("openrouter")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a value that is not an entry as a miss so a refetch can fix it", async () => {
    const warn = vi.fn();
    const store = memoryStore({ [cacheKey("openrouter")]: "{ this is not an entry" });

    expect(await new PricingCache(store, warn).read("openrouter")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("rejects a value whose rows no longer match the row shape", async () => {
    const warn = vi.fn();
    // A cache written by an older build, before `inputCost` was required.
    const store = memoryStore({
      [cacheKey("models-dev")]: { fetchedAt: Date.now(), etag: null, rows: [{ modelId: "old", name: "Old" }] },
    });

    expect(await new PricingCache(store, warn).read("models-dev")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("only looks for a missing value once", async () => {
    const store = memoryStore();
    const cache = new PricingCache(store);
    await cache.read("models-dev");
    await cache.read("models-dev");
    expect(store.get).toHaveBeenCalledTimes(1);
    // A hit written after the miss is served from memory, not re-read.
    cache.write("models-dev", entry({ rows: [row({ modelId: "fresh" })] }));
    expect((await cache.read("models-dev"))?.rows[0]?.modelId).toBe("fresh");
  });

  it("reports a failed write without throwing, because the rows in hand are still good", async () => {
    const warn = vi.fn();
    const store = memoryStore();
    // kv refuses a value over 256 KB the same way.
    store.set.mockRejectedValueOnce(new Error("value too large"));

    const cache = new PricingCache(store, warn);
    cache.write("models-dev", entry());
    await expect(cache.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("value too large"));
    // Memory still has it, which is the point.
    expect(await cache.read("models-dev")).not.toBeNull();
  });

  it("reports a failed read as a miss", async () => {
    const warn = vi.fn();
    const store = memoryStore();
    store.get.mockRejectedValueOnce(new Error("storage is closed"));

    expect(await new PricingCache(store, warn).read("models-dev")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("storage is closed"));
  });

  it("lands the writes queued before close, and skips every write after it", async () => {
    const store = memoryStore();
    const cache = new PricingCache(store);
    cache.write("models-dev", entry({ rows: [row({ modelId: "before" })] }));
    await cache.close();
    cache.write("models-dev", entry({ rows: [row({ modelId: "after" })] }));
    await cache.flush();

    expect(store.set).toHaveBeenCalledTimes(1);
    expect((store.values.get(cacheKey("models-dev")) as CacheEntry).rows[0]?.modelId).toBe("before");
  });
});

describe("isFresh", () => {
  it("is the twelve-hour window a load reuses", () => {
    const now = 1_700_000_000_000;
    expect(isFresh(entry({ fetchedAt: now - 1_000 }), now)).toBe(true);
    expect(isFresh(entry({ fetchedAt: now - TTL_MS + 1_000 }), now)).toBe(true);
    expect(isFresh(entry({ fetchedAt: now - TTL_MS - 1_000 }), now)).toBe(false);
  });
});
