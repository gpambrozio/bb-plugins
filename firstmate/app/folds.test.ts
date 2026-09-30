import { describe, expect, it } from "vitest";

import { readFolds, toggleFold } from "./folds";

function memoryStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("firstmate.folds", initial);
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

describe("readFolds", () => {
  it("is empty when nothing is stored", () => {
    expect(readFolds(memoryStorage())).toEqual(new Set());
  });

  it("is empty for bad JSON or the wrong shape", () => {
    expect(readFolds(memoryStorage("{nope"))).toEqual(new Set());
    expect(readFolds(memoryStorage('{"a":1}'))).toEqual(new Set());
  });

  it("reads the stored columns and drops unknown ones", () => {
    expect(readFolds(memoryStorage('["done","idle","bogus",3]'))).toEqual(new Set(["done", "idle"]));
  });
});

describe("toggleFold", () => {
  it("adds then removes a column, persisting each time", () => {
    const storage = memoryStorage();
    expect(toggleFold(storage, "done")).toEqual(new Set(["done"]));
    expect(JSON.parse(storage.getItem("firstmate.folds") ?? "")).toEqual(["done"]);
    expect(toggleFold(storage, "idle")).toEqual(new Set(["done", "idle"]));
    expect(toggleFold(storage, "done")).toEqual(new Set(["idle"]));
    expect(readFolds(storage)).toEqual(new Set(["idle"]));
  });

  it("starts over from bad stored JSON", () => {
    const storage = memoryStorage("{nope");
    expect(toggleFold(storage, "failed")).toEqual(new Set(["failed"]));
  });
});
