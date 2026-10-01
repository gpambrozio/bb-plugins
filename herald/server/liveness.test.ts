import { describe, expect, it } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import { LIVENESS_TTL_MS, Liveness, RUNNING_TTL_MS, SEEN_GRACE_MS } from "./liveness";
import type { LivenessPort, ThreadFacts } from "./ports";
import { AttentionStore } from "./store";
import { recordingLog } from "./testing/fixtures";

const T0 = Date.parse("2026-09-15T10:00:00.000Z");

function entry(overrides: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    threadId: "t1",
    projectId: "p1",
    projectName: "Shop",
    threadTitle: null,
    lastRequest: null,
    folder: null,
    reason: "finished",
    eventId: "t1:idle:1",
    requestId: null,
    createdAt: new Date(T0).toISOString(),
    headline: "Finished",
    detail: null,
    summary: { status: "ready", text: "Done." },
    ...overrides,
  };
}

function open(overrides: Partial<Extract<ThreadFacts, { kind: "open" }>> = {}): ThreadFacts {
  return { kind: "open", status: "idle", lastReadAt: T0 - 1000, latestAttentionAt: T0, ...overrides };
}

class FakePort implements LivenessPort {
  readonly facts_ = new Map<string, ThreadFacts>();
  readonly pending = new Map<string, boolean>();
  factCalls = 0;
  interactionCalls = 0;
  /** Runs inside a facts read, to land an event while it is in flight. */
  during: (() => void) | null = null;

  async facts(threadId: string): Promise<ThreadFacts> {
    this.factCalls += 1;
    this.during?.();
    return this.facts_.get(threadId) ?? { kind: "gone" };
  }

  async interactionPending(threadId: string, interactionId: string): Promise<boolean> {
    this.interactionCalls += 1;
    return this.pending.get(`${threadId}:${interactionId}`) ?? false;
  }
}

function setup(now: { value: number }) {
  const port = new FakePort();
  const store = new AttentionStore(null, recordingLog());
  const liveness = new Liveness(port, recordingLog(), () => now.value);
  return { port, store, liveness };
}

describe("Liveness.visible", () => {
  it("shows unread threads and removes archived, deleted or missing ones", async () => {
    const now = { value: T0 + 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ threadId: "t1", eventId: "e1" }));
    store.upsert(entry({ threadId: "t2", eventId: "e2" }));
    port.facts_.set("t1", open());
    // t2 is not known to bb any more.
    expect((await liveness.visible(store)).map((item) => item.threadId)).toEqual(["t1"]);
    expect(store.get("t2")).toBeNull();
  });

  it("removes an entry once the thread has been read, after the grace period", async () => {
    const now = { value: T0 + 1000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry());
    port.facts_.set("t1", open({ lastReadAt: T0 + 500 }));
    // Read already, but too young to judge: the user may be watching it finish.
    expect(await liveness.visible(store)).toHaveLength(1);
    now.value = T0 + SEEN_GRACE_MS + LIVENESS_TTL_MS;
    expect(await liveness.visible(store)).toHaveLength(0);
    expect(store.get("t1")).toBeNull();
  });

  it("keeps a question while it is pending, read or not, and removes it once answered", async () => {
    const now = { value: T0 + 10 * 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ reason: "question", requestId: "i1", eventId: "t1:interaction:i1" }));
    port.facts_.set("t1", open({ status: "active", lastReadAt: T0 + 60_000 }));
    port.pending.set("t1:i1", true);
    expect(await liveness.visible(store)).toHaveLength(1);
    port.pending.set("t1:i1", false);
    now.value += LIVENESS_TTL_MS;
    expect(await liveness.visible(store)).toHaveLength(0);
    expect(store.get("t1")).toBeNull();
  });

  it("does not delete a newer event recorded while the check was in flight", async () => {
    const now = { value: T0 + 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ eventId: "old" }));
    port.during = () => store.upsert(entry({ eventId: "new", createdAt: new Date(T0 + 59_000).toISOString() }));
    await liveness.visible(store);
    expect(store.get("t1")?.eventId).toBe("new");
  });

  it("re-reads a cached answer that predates the entry before deleting it", async () => {
    const now = { value: T0 - 5000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ threadId: "t1", eventId: "earlier", createdAt: new Date(T0 - 60_000).toISOString() }));
    // Read before the newer turn, so the cached answer says "read".
    port.facts_.set("t1", open({ lastReadAt: T0 - 10_000, latestAttentionAt: T0 - 20_000 }));
    await liveness.visible(store);
    store.upsert(entry({ threadId: "t1", eventId: "newer" }));
    now.value = T0 + SEEN_GRACE_MS + 1000;
    // bb has since recorded the newer attention, unread.
    port.facts_.set("t1", open({ lastReadAt: T0 - 10_000, latestAttentionAt: T0 }));
    expect((await liveness.visible(store)).map((item) => item.eventId)).toEqual(["newer"]);
  });

  it("withholds a finish from a thread that is working again, but not a question", async () => {
    const now = { value: T0 + 1000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ threadId: "t1", eventId: "f" }));
    store.upsert(entry({ threadId: "t2", eventId: "q", reason: "question", requestId: "i1" }));
    port.facts_.set("t1", open({ status: "active" }));
    port.facts_.set("t2", open({ status: "active" }));
    port.pending.set("t2:i1", true);
    expect((await liveness.visible(store)).map((item) => item.threadId)).toEqual(["t2"]);
    // Hidden, not removed: the hooks take it back for good when its summary lands.
    expect(store.get("t1")).not.toBeNull();
  });

  it("re-reads a finish rather than trusting an answer seconds old", async () => {
    const now = { value: T0 + 1000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry());
    port.facts_.set("t1", open({ status: "active" }));
    expect(await liveness.visible(store)).toHaveLength(0);
    port.facts_.set("t1", open({ status: "idle" }));
    now.value += RUNNING_TTL_MS + 1;
    expect(await liveness.visible(store)).toHaveLength(1);
  });

  it("asks bb about a thread at most once per TTL", async () => {
    const now = { value: T0 + 1000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ reason: "error" }));
    port.facts_.set("t1", open());
    await liveness.visible(store);
    await liveness.visible(store);
    expect(port.factCalls).toBe(1);
    now.value += LIVENESS_TTL_MS;
    await liveness.visible(store);
    expect(port.factCalls).toBe(2);
  });

  it("keeps an entry it cannot check", async () => {
    const now = { value: T0 + 10 * 60_000 };
    const store = new AttentionStore(null, recordingLog());
    const log = recordingLog();
    const liveness = new Liveness(
      {
        facts: async () => {
          throw new Error("offline");
        },
        interactionPending: async () => {
          throw new Error("offline");
        },
      },
      log,
      () => now.value,
    );
    store.upsert(entry());
    store.upsert(entry({ threadId: "t2", reason: "question", requestId: "i1" }));
    expect(await liveness.visible(store)).toHaveLength(2);
    expect(log.lines).toContain("warn: Could not check thread t1: offline");
  });
});
