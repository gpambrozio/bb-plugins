/**
 * How many summary helpers may be alive at once — across every instance of
 * the plugin, not per instance. A helper an unloading instance handed over
 * keeps its slot until the instance that took it has stopped and deleted it,
 * so a reload cannot add a fresh pair of helpers on top of a stopping pair.
 */
export interface Slots {
  /** Resolves with the slot's release once one is free, first come first served. */
  acquire(): Promise<() => void>;
  readonly inUse: number;
}

export function createSlots(max: number): Slots {
  let used = 0;
  const waiting: Array<() => void> = [];
  return {
    get inUse() {
      return used;
    },
    acquire() {
      return new Promise((resolve) => {
        const grant = () => {
          used += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            used -= 1;
            waiting.shift()?.();
          });
        };
        if (used < max) grant();
        else waiting.push(grant);
      });
    },
  };
}

/**
 * The plugin's one set of slots, shared by its instances through `globalThis`
 * (they run in the bb server's one process; see `reload-signal.ts`).
 */
function sharedKey(pluginId: string): symbol {
  return Symbol.for(`bb-plugin:${pluginId}:helper-slots`);
}

export function sharedSlots(pluginId: string, max: number): Slots {
  const key = sharedKey(pluginId);
  const holder = globalThis as Record<symbol, Slots | undefined>;
  holder[key] ??= createSlots(max);
  return holder[key];
}

/** For tests, whose plugin instances share one process and one plugin id: start from free slots. */
export function resetSharedSlotsForTests(pluginId: string): void {
  delete (globalThis as Record<symbol, Slots | undefined>)[sharedKey(pluginId)];
}
