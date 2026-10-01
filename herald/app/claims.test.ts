// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { CLAIM_TTL_MS, claimAnnouncement, onClaimReleased, releaseKey } from "./claims";

class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  keys(): string[] {
    return [...this.items.keys()];
  }
}

describe("claimAnnouncement", () => {
  it("lets the first window claim an event and no other", async () => {
    const storage = new MemoryStorage();
    const environment = { storage, locks: null, now: () => 1000 };
    expect(await claimAnnouncement("herald:said:", "e1", environment)).not.toBeNull();
    expect(await claimAnnouncement("herald:said:", "e1", environment)).toBeNull();
    expect(await claimAnnouncement("herald:said:", "e2", environment)).not.toBeNull();
  });

  it("gives a released claim back, for another window to take", async () => {
    const storage = new MemoryStorage();
    const environment = { storage, locks: null, now: () => 1000 };
    const claim = await claimAnnouncement("herald:said:", "e1", environment);
    await claim?.release();
    expect(await claimAnnouncement("herald:said:", "e1", environment)).not.toBeNull();
  });

  it("checks under a lock named for the event, held only for the check", async () => {
    const storage = new MemoryStorage();
    const names: string[] = [];
    const locks = {
      request: (async (name: string, callback: () => unknown) => {
        names.push(name);
        return callback();
      }) as unknown as LockManager["request"],
    };
    expect(await claimAnnouncement("herald:said:", "e1", { storage, locks, now: () => 0 })).not.toBeNull();
    expect(names).toEqual(["herald:said:e1"]);
  });

  it("forgets claims a day old, and leaves other keys alone", async () => {
    const storage = new MemoryStorage();
    storage.setItem("other", "x");
    let now = 0;
    const environment = { storage, locks: null, now: () => now };
    await claimAnnouncement("herald:said:", "old", environment);
    now = CLAIM_TTL_MS + 1;
    await claimAnnouncement("herald:said:", "new", environment);
    expect(storage.keys().sort()).toEqual(["herald:said:new", "other"]);
  });

  it("speaks everywhere when there is no storage", async () => {
    expect(await claimAnnouncement("p:", "e1", { storage: null, locks: null, now: () => 0 })).not.toBeNull();
    expect(await claimAnnouncement("p:", "e1", { storage: null, locks: null, now: () => 0 })).not.toBeNull();
  });

  it("hears only an explicit release, never a claim key removed by pruning", () => {
    const heard: string[] = [];
    const stop = onClaimReleased("herald:said:", (eventId) => heard.push(eventId));
    const fire = (key: string | null, newValue: string | null) =>
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    fire("herald:said:#released", JSON.stringify({ eventId: "e1", at: 1 }));
    // A day-old claim pruned by another window's new announcement: silent.
    fire("herald:said:e2", null);
    fire("other:#released", JSON.stringify({ eventId: "e3", at: 1 }));
    fire(null, null);
    stop();
    fire("herald:said:#released", JSON.stringify({ eventId: "e4", at: 2 }));
    expect(heard).toEqual(["e1"]);
  });

  it("says a release on the notification key, and prunes a day-old claim without a word", async () => {
    const storage = new MemoryStorage();
    const writes: string[] = [];
    const recording = {
      ...storage,
      get length() {
        return storage.length;
      },
      key: (index: number) => storage.key(index),
      getItem: (key: string) => storage.getItem(key),
      removeItem: (key: string) => storage.removeItem(key),
      setItem: (key: string, value: string) => {
        writes.push(key);
        storage.setItem(key, value);
      },
    };
    let now = 0;
    const environment = { storage: recording, locks: null, now: () => now };
    // Another window spoke e1 successfully: its claim stays until pruned.
    await claimAnnouncement("herald:said:", "e1", environment);
    now = CLAIM_TTL_MS + 1;
    await claimAnnouncement("herald:said:", "e2", environment);
    expect(storage.getItem("herald:said:e1")).toBeNull();
    expect(writes).not.toContain(releaseKey("herald:said:"));

    // A refused window gives e2 back: that is said, once per release.
    const claim = await claimAnnouncement("herald:said:", "e3", environment);
    await claim?.release();
    expect(writes.filter((key) => key === releaseKey("herald:said:"))).toHaveLength(1);
    expect(JSON.parse(storage.getItem(releaseKey("herald:said:")) ?? "{}").eventId).toBe("e3");
    // And the notification key is never pruned as a claim.
    now += CLAIM_TTL_MS * 2;
    await claimAnnouncement("herald:said:", "e4", environment);
    expect(storage.getItem(releaseKey("herald:said:"))).not.toBeNull();
  });
});
