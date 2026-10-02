import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import { kvBackend } from "./kv-backend";
import { AttentionStore, type StoreBackend } from "./store";
import { recordingLog } from "./testing/fixtures";

function entry(overrides: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    threadId: "t1",
    projectId: "p1",
    projectName: "Shop",
    threadTitle: "Login fix",
    lastRequest: null,
    folder: "repo",
    reason: "question",
    eventId: "t1:interaction:i1",
    requestId: "i1",
    createdAt: "2026-09-15T10:00:00.000Z",
    headline: "Which DB?",
    detail: "A / B",
    summary: { status: "ready", text: "Login fix has a question: Which DB? Options: A / B." },
    ...overrides,
  };
}

/**
 * Storage that answers a tick later, like bb's, and can hold a read open so a
 * test can land events in the middle of it.
 */
class FakeBackend implements StoreBackend {
  saved: unknown[] = [];
  writes = 0;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  holdReads(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  releaseReads(): void {
    this.open?.();
    this.gate = null;
  }

  async read(): Promise<unknown[]> {
    const snapshot = structuredClone(this.saved);
    await (this.gate ?? new Promise((resolve) => setTimeout(resolve, 0)));
    return snapshot;
  }

  async write(entries: readonly AttentionEntry[]): Promise<void> {
    const snapshot = structuredClone([...entries]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.writes += 1;
    this.saved = snapshot;
  }

  threadIds(): string[] {
    return (this.saved as AttentionEntry[]).map((item) => item.threadId).sort();
  }
}

describe("AttentionStore", () => {
  it("keeps one entry per thread, newest first", () => {
    const store = new AttentionStore(null, recordingLog());
    store.upsert(entry({ threadId: "t1", createdAt: "2026-09-15T10:00:00.000Z" }));
    store.upsert(entry({ threadId: "t2", createdAt: "2026-09-15T11:00:00.000Z" }));
    store.upsert(entry({ threadId: "t1", eventId: "t1:idle:1", createdAt: "2026-09-15T11:30:00.000Z" }));
    expect(store.list().map((item) => `${item.threadId}:${item.eventId}`)).toEqual([
      "t1:t1:idle:1",
      "t2:t1:interaction:i1",
    ]);
  });

  it("removes on request and by predicate", () => {
    const store = new AttentionStore(null, recordingLog());
    store.upsert(entry());
    expect(store.removeIf("t1", (item) => item.requestId === "nope")).toBe(false);
    expect(store.removeIf("t1", (item) => item.requestId === "i1")).toBe(true);
    expect(store.get("t1")).toBeNull();
    expect(store.remove("t1")).toBeNull();
    store.upsert(entry());
    expect(store.remove("t1")?.threadId).toBe("t1");
  });

  it("does not let a slow load undo what arrived while it was reading", async () => {
    const backend = new FakeBackend();
    backend.saved = [entry({ threadId: "t1", eventId: "t1:idle:old", headline: "Older" }), entry({ threadId: "t2" })];

    const store = new AttentionStore(backend, recordingLog());
    backend.holdReads();
    const loading = store.load();
    store.upsert(entry({ threadId: "t1", eventId: "t1:idle:new", headline: "Newer" }));
    store.remove("t2");
    backend.releaseReads();
    await loading;

    expect(store.get("t1")?.eventId).toBe("t1:idle:new");
    expect(store.get("t2")).toBeNull();
  });

  it("leaves the merged map in storage, not just in memory", async () => {
    const backend = new FakeBackend();
    backend.saved = [entry({ threadId: "t1", eventId: "t1:idle:old" }), entry({ threadId: "t2" }), entry({ threadId: "t3" })];

    // The upsert queues a write while the map holds t1 alone; mirroring that
    // would erase t2 and t3 from the very storage being read.
    const store = new AttentionStore(backend, recordingLog());
    backend.holdReads();
    const loading = store.load();
    store.upsert(entry({ threadId: "t1", eventId: "t1:idle:new" }));
    backend.releaseReads();
    await loading;
    await store.flush();

    expect(backend.threadIds()).toEqual(["t1", "t2", "t3"]);
    expect((backend.saved as AttentionEntry[]).find((item) => item.threadId === "t1")?.eventId).toBe("t1:idle:new");

    // And the next load reads back exactly that.
    const reopened = new AttentionStore(backend, recordingLog());
    await reopened.load();
    expect(reopened.list().map((item) => item.threadId).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("applies a conditional removal that arrived before its entry was read", async () => {
    const backend = new FakeBackend();
    backend.saved = [
      entry({ threadId: "t1", requestId: "i1", eventId: "t1:interaction:i1" }),
      entry({ threadId: "t2", requestId: "i2", eventId: "t2:interaction:i2" }),
    ];

    const store = new AttentionStore(backend, recordingLog());
    backend.holdReads();
    const loading = store.load();
    // An interaction answered while its entry is still only in storage. The
    // test cannot run yet, so it is held for the merge rather than dropped.
    expect(store.removeIf("t1", (item) => item.requestId === "i1")).toBe(false);
    // One whose test does not match must leave its row alone.
    store.removeIf("t2", (item) => item.requestId === "answered elsewhere");
    backend.releaseReads();
    await loading;

    expect(store.get("t1")).toBeNull();
    expect(store.get("t2")?.requestId).toBe("i2");

    // And it is gone from storage, so the next load does not restore it.
    await store.flush();
    expect(backend.threadIds()).toEqual(["t2"]);
  });

  it("picks up what the replaced instance wrote after this one loaded, keeping its own live changes", async () => {
    // The real backend — one kv row per thread — over a kv whose writes can be held.
    const rows = new Map<string, unknown>();
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    const kv: PluginKvStorage = {
      get: async <T,>(key: string) => rows.get(key) as T | undefined,
      set: async (key, value) => {
        await gate;
        rows.set(key, structuredClone(value));
      },
      delete: async (key) => {
        await gate;
        rows.delete(key);
      },
      list: async (prefix = "") => [...rows.keys()].filter((key) => key.startsWith(prefix)),
    };
    const old = new AttentionStore(kvBackend(kv), recordingLog());
    old.upsert(entry({ threadId: "t1" }));
    await old.flush();

    // The old instance records t2, but its write is slow to land.
    gate = new Promise<void>((resolve) => (open = resolve));
    old.upsert(entry({ threadId: "t2", summary: { status: "ready", text: "Old." } }));

    // A reload: the replacement loads before the old instance has flushed.
    const replacement = new AttentionStore(kvBackend(kv), recordingLog());
    await replacement.load();
    expect(replacement.get("t2")).toBeNull();
    replacement.upsert(entry({ threadId: "t3" }));

    open();
    gate = null;
    await old.flush();
    // The old instance says it has drained; the replacement reads again.
    await replacement.reconcile();
    await replacement.flush();

    expect(replacement.list().map((item) => item.threadId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(replacement.get("t2")?.summary).toEqual({ status: "ready", text: "Old." });
    expect([...rows.keys()].sort()).toEqual(["entry:t1", "entry:t2", "entry:t3"]);
  });

  it("does not let its own write in flight delete a row a reconcile just found", async () => {
    const rows = new Map<string, unknown>();
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    const kv: PluginKvStorage = {
      get: async <T,>(key: string) => rows.get(key) as T | undefined,
      set: async (key, value) => {
        await gate;
        rows.set(key, structuredClone(value));
      },
      delete: async (key) => {
        await gate;
        rows.delete(key);
      },
      list: async (prefix = "") => [...rows.keys()].filter((key) => key.startsWith(prefix)),
    };
    rows.set("entry:t1", entry({ threadId: "t1" }));
    const replacement = new AttentionStore(kvBackend(kv), recordingLog());
    await replacement.load();
    // The old instance writes t2 straight to storage after the replacement loaded.
    rows.set("entry:t2", entry({ threadId: "t2" }));

    // The replacement's own write is under way, held, when the reconcile starts.
    gate = new Promise<void>((resolve) => (open = resolve));
    replacement.upsert(entry({ threadId: "t3" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconciling = replacement.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    open();
    gate = null;
    await reconciling;
    await replacement.flush();

    expect(replacement.list().map((item) => item.threadId).sort()).toEqual(["t1", "t2", "t3"]);
    expect([...rows.keys()].sort()).toEqual(["entry:t1", "entry:t2", "entry:t3"]);
  });

  it("refuses a write requested during its unload flush, so nothing lands after it", async () => {
    const rows = new Map<string, unknown>();
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    let sets = 0;
    const kv: PluginKvStorage = {
      get: async <T,>(key: string) => rows.get(key) as T | undefined,
      set: async (key, value) => {
        await gate;
        sets += 1;
        rows.set(key, structuredClone(value));
      },
      delete: async (key) => {
        await gate;
        rows.delete(key);
      },
      list: async (prefix = "") => [...rows.keys()].filter((key) => key.startsWith(prefix)),
    };
    const store = new AttentionStore(kvBackend(kv), recordingLog());
    await store.load();
    // A write is under way when unload starts.
    gate = new Promise<void>((resolve) => (open = resolve));
    store.upsert(entry({ threadId: "t1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shutting = store.shutdown();
    // A summary settles in the middle of the flush.
    store.upsert(entry({ threadId: "t2" }));
    open();
    gate = null;
    await shutting;
    const landed = sets;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sets).toBe(landed);
    expect([...rows.keys()]).toEqual(["entry:t1"]);
  });

  it("drops on reconcile an entry the replaced instance removed after this one loaded", async () => {
    const backend = new FakeBackend();
    backend.saved = [entry({ threadId: "t1" }), entry({ threadId: "t2" })];
    const replacement = new AttentionStore(backend, recordingLog());
    await replacement.load();
    await replacement.flush();
    backend.saved = [entry({ threadId: "t2" })];
    await replacement.reconcile();
    expect(replacement.list().map((item) => item.threadId)).toEqual(["t2"]);
  });

  it("survives a reload", async () => {
    const backend = new FakeBackend();
    const first = new AttentionStore(backend, recordingLog());
    await first.load(); // nothing saved yet is fine
    first.upsert(entry({ threadId: "t1" }));
    first.upsert(entry({ threadId: "t2", summary: { status: "off", fallback: "Done." } }));
    await first.flush();
    expect(backend.saved).toHaveLength(2);

    const second = new AttentionStore(backend, recordingLog());
    await second.load();
    expect(second.get("t1")).toEqual(entry({ threadId: "t1" }));
    expect(second.get("t2")?.summary).toEqual({ status: "off", fallback: "Done." });
  });

  it("drops an unreadable saved entry, says so, and writes it out of storage", async () => {
    const backend = new FakeBackend();
    backend.saved = [entry({ threadId: "t1" }), { threadId: "t2", nonsense: true }];
    const log = recordingLog();
    const store = new AttentionStore(backend, log);
    await store.load();
    await store.flush();
    expect(store.list().map((item) => item.threadId)).toEqual(["t1"]);
    expect(backend.threadIds()).toEqual(["t1"]);
    expect(log.lines.some((line) => line.startsWith("warn: Dropping an unreadable saved entry"))).toBe(true);
  });

  it("reports a failed write and keeps going", async () => {
    const log = recordingLog();
    let fail = true;
    const store = new AttentionStore(
      {
        read: async () => [],
        write: async () => {
          if (fail) throw new Error("disk full");
        },
      },
      log,
    );
    store.upsert(entry());
    await store.flush();
    expect(log.lines).toContain("error: Could not save Herald's entries: disk full");
    fail = false;
    store.remove("t1");
    await store.flush();
    expect(log.lines.filter((line) => line.startsWith("error:"))).toHaveLength(1);
  });
});

describe("settlePending", () => {
  it("leaves alone the sentences this instance is itself still writing", () => {
    const store = new AttentionStore(null, recordingLog());
    store.upsert(entry({ threadId: "t1", eventId: "mine", summary: { status: "pending", fallback: "Mine." } }));
    store.upsert(entry({ threadId: "t2", eventId: "theirs", summary: { status: "pending", fallback: "Theirs." } }));
    expect(store.settlePending(new Set(["mine"]))).toBe(true);
    expect(store.get("t1")?.summary.status).toBe("pending");
    expect(store.get("t2")?.summary).toEqual({ status: "ready", text: "Theirs." });
  });

  it("turns every sentence still being written into its plain fallback, and says whether anything changed", async () => {
    const backend = new FakeBackend();
    // As a load finds them: left by the instance before, not written by this one.
    backend.saved = [
      entry({ threadId: "t1", summary: { status: "pending", fallback: "Login fix finished." } }),
      entry({ threadId: "t2", summary: { status: "ready", text: "Done." } }),
    ];
    const store = new AttentionStore(backend, recordingLog());
    await store.load();
    expect(store.settlePending()).toBe(true);
    expect(store.get("t1")?.summary).toEqual({ status: "ready", text: "Login fix finished." });
    expect(store.get("t2")?.summary).toEqual({ status: "ready", text: "Done." });
    expect(store.settlePending()).toBe(false);
    await store.flush();
    expect((backend.saved as AttentionEntry[]).find((saved) => saved.threadId === "t1")?.summary).toEqual({
      status: "ready",
      text: "Login fix finished.",
    });
    // Promoting is not a claim: a later read of storage still wins for that thread, as a
    // removal the instance before made on its way out must.
    backend.saved = backend.saved.filter((saved) => (saved as AttentionEntry).threadId !== "t1");
    await store.reconcile();
    expect(store.get("t1")).toBeNull();
  });
});
