import { describe, expect, it } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import { LIVENESS_TTL_MS, Liveness } from "./liveness";
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
  factCalls = 0;
  /** Runs inside a facts read, to land an event while it is in flight. */
  during: (() => void) | null = null;

  async facts(threadId: string): Promise<ThreadFacts> {
    this.factCalls += 1;
    this.during?.();
    return this.facts_.get(threadId) ?? { kind: "gone" };
  }
}

function setup(now: { value: number }) {
  const port = new FakePort();
  const store = new AttentionStore(null, recordingLog());
  const liveness = new Liveness(port, recordingLog(), () => now.value);
  return { port, store, liveness };
}

describe("Liveness", () => {
  it("lists every entry whose thread still exists and removes archived, deleted or missing ones", async () => {
    const now = { value: T0 + 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ threadId: "t1", eventId: "e1" }));
    store.upsert(entry({ threadId: "t2", eventId: "e2" }));
    port.facts_.set("t1", open());
    // t2 is not known to bb any more.
    expect((await liveness.visible(store)).map((item) => item.threadId)).toEqual(["t1"]);
    expect(store.get("t2")).toBeNull();
  });

  it("keeps an entry the user has read: the sentence is the thread's last event, not its unread dot", async () => {
    const now = { value: T0 + 10 * 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry());
    port.facts_.set("t1", open({ lastReadAt: T0 + 500 }));
    expect(await liveness.visible(store)).toHaveLength(1);
    expect(store.get("t1")).not.toBeNull();
  });

  it("keeps a question after it was answered, and a finish on a thread working again", async () => {
    const now = { value: T0 + 10 * 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ threadId: "t1", reason: "question", requestId: "i1", eventId: "t1:interaction:i1" }));
    store.upsert(entry({ threadId: "t2", eventId: "f" }));
    port.facts_.set("t1", open({ status: "active", lastReadAt: T0 + 60_000 }));
    port.facts_.set("t2", open({ status: "active" }));
    expect((await liveness.visible(store)).map((item) => item.threadId).sort()).toEqual(["t1", "t2"]);
  });

  it("does not delete a newer event recorded while the check was in flight", async () => {
    const now = { value: T0 + 60_000 };
    const { port, store, liveness } = setup(now);
    store.upsert(entry({ eventId: "old" }));
    port.during = () => store.upsert(entry({ eventId: "new", createdAt: new Date(T0 + 59_000).toISOString() }));
    await liveness.visible(store);
    expect(store.get("t1")?.eventId).toBe("new");
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
      },
      log,
      () => now.value,
    );
    store.upsert(entry());
    expect(await liveness.visible(store)).toHaveLength(1);
    expect(log.lines).toContain("warn: Could not check thread t1: offline");
  });
});
