import { describe, expect, it } from "vitest";

import { createRemovalGate, suggestionRemovals } from "./suggestion-removals";

describe("createRemovalGate", () => {
  const a = { label: "A", prompt: "a" };
  const b = { label: "B", prompt: "b" };
  const c = { label: "C", prompt: "c" };

  it("keeps a pending removal on its suggestion wherever the list moves it", () => {
    const gate = createRemovalGate();
    let finish = (): void => {};
    const removing = gate.run(b, () => new Promise<void>((resolve) => (finish = resolve)));
    expect(removing).not.toBeNull();
    // A poll drops A while B's removal is out: B moves up, C takes its old place.
    const list = [b, c];
    expect(list.map((suggestion) => gate.pending(suggestion))).toEqual([true, false]);
    expect(gate.run(b, () => Promise.resolve())).toBeNull();
    finish();
    return removing?.then(() => expect(gate.pending(b)).toBe(false));
  });

  it("starts one removal for two presses before a redraw, identical twins included", async () => {
    const changes: number[] = [];
    const gate = createRemovalGate();
    gate.subscribe(() => changes.push(gate.version()));
    const started: string[] = [];
    const first = gate.run(a, () => {
      started.push("first");
      return Promise.resolve();
    });
    expect(gate.run({ ...a }, () => Promise.resolve())).toBeNull();
    expect(gate.pending(b)).toBe(false);
    await first;
    expect(started).toEqual(["first"]);
    expect(gate.pending(a)).toBe(false);
    expect(changes).toEqual([1, 2]);
  });

  it("reopens after a task that fails or throws", async () => {
    const gate = createRemovalGate();
    await expect(gate.run(a, () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(gate.pending(a)).toBe(false);
    await expect(
      gate.run(a, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(gate.pending(a)).toBe(false);
  });
});

describe("suggestionRemovals", () => {
  it("outlives the list: a remount finds a removal still out, and cannot start a second", async () => {
    const pair = { label: "Land", prompt: "Merge it" };
    const requests: string[] = [];
    let finish = (): void => {};
    // The first list subscribes, starts the removal, and unmounts — a tab switch.
    const unsubscribe = suggestionRemovals.subscribe(() => {});
    const removing = suggestionRemovals.run(pair, () => {
      requests.push("first");
      return new Promise<void>((resolve) => (finish = resolve));
    });
    unsubscribe();

    // The list that mounts next reads the same gate.
    const seen: number[] = [];
    const unsubscribeNext = suggestionRemovals.subscribe(() => seen.push(suggestionRemovals.version()));
    expect(suggestionRemovals.pending({ ...pair })).toBe(true);
    expect(suggestionRemovals.run({ ...pair }, () => (requests.push("second"), Promise.resolve()))).toBeNull();

    finish();
    await removing;
    expect(requests).toEqual(["first"]);
    expect(suggestionRemovals.pending(pair)).toBe(false);
    expect(seen).toHaveLength(1);
    unsubscribeNext();
  });
});
