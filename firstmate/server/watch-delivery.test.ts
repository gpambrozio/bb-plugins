import { describe, expect, it } from "vitest";

import { createDeliver } from "./watch-delivery";
import { fakeThreads, memoryStore } from "./testing/fakes";

function setup() {
  const threads = fakeThreads();
  const store = memoryStore();
  return { threads, store, deliver: createDeliver({ threads, store }) };
}

describe("createDeliver", () => {
  it("waits, and sends nothing, while no first mate is stored", async () => {
    const { threads, deliver } = setup();
    threads.add({ status: "idle" });

    await expect(deliver("watch output")).resolves.toBe("wait");
    expect(threads.callsTo("send")).toEqual([]);
  });

  it("waits while the first mate is mid-turn", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "active" });
    await store.setMateThreadId(mate.id);

    await expect(deliver("watch output")).resolves.toBe("wait");
    expect(threads.callsTo("send")).toEqual([]);
  });

  it("sends once, queued behind any turn that starts meanwhile, when the first mate is idle", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "idle" });
    await store.setMateThreadId(mate.id);

    await expect(deliver("watch output")).resolves.toBe("sent");
    expect(threads.callsTo("send")).toEqual([[mate.id, "watch output", "queue-if-active"]]);
  });

  it("waits when the stored first mate is gone", async () => {
    const { threads, store, deliver } = setup();
    const mate = threads.add({ status: "idle" });
    await store.setMateThreadId(mate.id);
    threads.archiveNow(mate.id);

    await expect(deliver("watch output")).resolves.toBe("wait");
    expect(threads.callsTo("send")).toEqual([]);
  });

  it("waits when the stored id names no thread at all", async () => {
    const { threads, store, deliver } = setup();
    await store.setMateThreadId("thr_missing");

    await expect(deliver("watch output")).resolves.toBe("wait");
    expect(threads.callsTo("send")).toEqual([]);
  });
});
