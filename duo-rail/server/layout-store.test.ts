import { describe, expect, it, vi } from "vitest";

import { defaultLayout, serializeLayout, type Layout } from "../shared/layout";
import { createLayoutStore, LAYOUT_KEY } from "./layout-store";

const custom: Layout = { version: 1, folded: { buttons: [{ id: "b", label: "Back", icon: "ArrowLeft", action: { kind: "back" } }] }, unfolded: { buttons: [] } };

function store(options: { row?: unknown; legacy?: unknown; dropFails?: boolean } = {}) {
  const rows = new Map<string, unknown>(options.row === undefined ? [] : [[LAYOUT_KEY, options.row]]);
  const deps = {
    kv: {
      get: async <T,>(key: string) => rows.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void rows.set(key, value),
    },
    readLegacy: vi.fn(async () => options.legacy),
    dropLegacy: vi.fn(async () => {
      if (options.dropFails) throw new Error("bb is busy");
      options.legacy = undefined;
    }),
    changed: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { store: createLayoutStore(deps), deps, rows };
}

describe("the layout store", () => {
  it("answers the default when nothing is saved", async () => {
    expect(await store().store.get()).toEqual({ layout: defaultLayout(), problem: null });
  });

  it("saves a layout, and tells every reader", async () => {
    const { store: s, deps, rows } = store();
    await s.set(custom);
    expect(rows.get(LAYOUT_KEY)).toEqual(custom);
    expect(deps.changed).toHaveBeenCalledOnce();
    expect(await s.get()).toEqual({ layout: custom, problem: null });
  });

  it("answers the default, and says why, for a stored row it cannot read", async () => {
    const answer = await store({ row: { version: 9 } }).store.get();
    expect(answer.layout).toEqual(defaultLayout());
    expect(answer.problem).toMatch(/could not be read/);
  });

  describe("moving the old layout setting", () => {
    it("moves a layout saved in the old setting into the store, and drops the setting", async () => {
      const { store: s, deps, rows } = store({ legacy: serializeLayout(custom) });
      expect(await s.get()).toEqual({ layout: custom, problem: null });
      expect(rows.get(LAYOUT_KEY)).toEqual(custom);
      expect(deps.dropLegacy).toHaveBeenCalledOnce();
      // Once per load.
      await s.get();
      expect(deps.readLegacy).toHaveBeenCalledOnce();
    });

    it.each([["empty", "  "], ["broken", "{ nope"]])("drops an %s old setting without storing anything", async (_, legacy) => {
      const { store: s, deps, rows } = store({ legacy });
      expect(await s.get()).toEqual({ layout: defaultLayout(), problem: null });
      expect(rows.has(LAYOUT_KEY)).toBe(false);
      expect(deps.dropLegacy).toHaveBeenCalledOnce();
    });

    it("keeps a layout already in the store over the old setting, and still drops the setting", async () => {
      const { store: s, deps } = store({ row: custom, legacy: serializeLayout(defaultLayout()) });
      expect((await s.get()).layout).toEqual(custom);
      expect(deps.dropLegacy).toHaveBeenCalledOnce();
    });

    it("does nothing when there is no old setting", async () => {
      const { store: s, deps } = store();
      await s.get();
      expect(deps.dropLegacy).not.toHaveBeenCalled();
    });

    it("tries again on the next read when dropping the setting fails, without losing the moved layout", async () => {
      const { store: s, deps, rows } = store({ legacy: serializeLayout(custom), dropFails: true });
      await expect(s.get()).rejects.toThrow("bb is busy");
      expect(rows.get(LAYOUT_KEY)).toEqual(custom);
      await expect(s.get()).rejects.toThrow("bb is busy");
      expect(deps.readLegacy).toHaveBeenCalledTimes(2);
    });

    it("lets a save win over a migration that failed", async () => {
      const { store: s, rows } = store({ legacy: serializeLayout(defaultLayout()), dropFails: true });
      await s.set(custom);
      expect(rows.get(LAYOUT_KEY)).toEqual(custom);
    });
  });
});
