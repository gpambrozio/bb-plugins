import { describe, expect, it } from "vitest";

import { COLUMN_IDS } from "../shared/types";
import { moveColumn, readColumnOrder } from "./column-order";

function memoryStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("firstmate.order", initial);
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("readColumnOrder", () => {
  it("is the default order when nothing is stored", () => {
    expect(readColumnOrder(memoryStorage())).toEqual([...COLUMN_IDS]);
  });

  it("is the default order for bad JSON or the wrong shape", () => {
    expect(readColumnOrder(memoryStorage("{nope"))).toEqual([...COLUMN_IDS]);
    expect(readColumnOrder(memoryStorage('{"a":1}'))).toEqual([...COLUMN_IDS]);
  });

  it("drops unknown and repeated columns and appends missing ones in the default order", () => {
    expect(readColumnOrder(memoryStorage('["idle","bogus","done","idle",3]'))).toEqual([
      "idle",
      "done",
      "queued",
      "working",
      "blocked",
      "parked",
      "failed",
    ]);
  });
});

describe("moveColumn", () => {
  const everything = new Set(COLUMN_IDS);

  it("moves a column up past its neighbour and persists the order", () => {
    const storage = memoryStorage();
    const order = moveColumn(storage, "idle", "up", everything);
    expect(order).toEqual(["queued", "working", "blocked", "parked", "done", "idle", "failed"]);
    expect(readColumnOrder(storage)).toEqual(order);
  });

  it("moves a column down past its neighbour", () => {
    expect(moveColumn(memoryStorage(), "queued", "down", everything)).toEqual([
      "working",
      "queued",
      "blocked",
      "parked",
      "done",
      "failed",
      "idle",
    ]);
  });

  it("skips columns that are not shown, so every press visibly moves the section", () => {
    const shown = new Set(["done", "idle"] as const);
    expect(moveColumn(memoryStorage(), "idle", "up", shown)).toEqual([
      "queued",
      "working",
      "blocked",
      "parked",
      "idle",
      "done",
      "failed",
    ]);
  });

  it("leaves the order alone at either end", () => {
    const storage = memoryStorage();
    expect(moveColumn(storage, "queued", "up", everything)).toEqual([...COLUMN_IDS]);
    expect(moveColumn(storage, "idle", "down", everything)).toEqual([...COLUMN_IDS]);
    expect(storage.getItem("firstmate.order")).toBeNull();
  });
});
