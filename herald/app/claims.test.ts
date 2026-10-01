import { describe, expect, it } from "vitest";

import { CLAIM_TTL_MS, claimAnnouncement } from "./claims";

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
    expect(await claimAnnouncement("herald:said:", "e1", environment)).toBe(true);
    expect(await claimAnnouncement("herald:said:", "e1", environment)).toBe(false);
    expect(await claimAnnouncement("herald:said:", "e2", environment)).toBe(true);
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
    expect(await claimAnnouncement("herald:said:", "e1", { storage, locks, now: () => 0 })).toBe(true);
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
    expect(await claimAnnouncement("p:", "e1", { storage: null, locks: null, now: () => 0 })).toBe(true);
    expect(await claimAnnouncement("p:", "e1", { storage: null, locks: null, now: () => 0 })).toBe(true);
  });
});
