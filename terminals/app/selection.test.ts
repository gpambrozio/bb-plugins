import { describe, expect, it } from "vitest";

import { createSelectionStore, resolveSelection, selectionAfterClose } from "./selection";

describe("resolveSelection", () => {
  it("keeps the wanted tab while it is open", () => {
    expect(resolveSelection(["a", "b", "c"], "b")).toBe("b");
  });

  it("falls back to the last tab when the wanted one is gone or unset", () => {
    expect(resolveSelection(["a", "b"], "gone")).toBe("b");
    expect(resolveSelection(["a", "b"], null)).toBe("b");
  });

  it("selects nothing with no tabs", () => {
    expect(resolveSelection([], "a")).toBeNull();
  });
});

describe("selectionAfterClose", () => {
  it("leaves the selection alone when another tab closes", () => {
    expect(selectionAfterClose(["a", "b", "c"], "a", "c")).toBe("c");
  });

  it("moves to the right-hand neighbour, else the left", () => {
    expect(selectionAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(selectionAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
  });

  it("selects nothing when the last tab closes", () => {
    expect(selectionAfterClose(["a"], "a", "a")).toBeNull();
  });
});

describe("createSelectionStore", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }

  it("survives a reload through storage", () => {
    const storage = memoryStorage();
    createSelectionStore(storage).set("term_1");
    expect(createSelectionStore(storage).get()).toBe("term_1");
    createSelectionStore(storage).set(null);
    expect(createSelectionStore(storage).get()).toBeNull();
  });

  it("still holds the selection when storage throws", () => {
    const store = createSelectionStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    });
    expect(store.get()).toBeNull();
    store.set("term_2");
    expect(store.get()).toBe("term_2");
  });

  it("works with no storage at all", () => {
    const store = createSelectionStore(null);
    store.set("term_3");
    expect(store.get()).toBe("term_3");
  });
});
