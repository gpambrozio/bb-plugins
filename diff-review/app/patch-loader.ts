/**
 * Loads file patches bb did not send with the file list, without anyone asking: each file asks for its
 * patch when it comes near the screen (`useNearScreen`), and the loader gathers the asks into batches,
 * one request at a time, so a diff of hundreds of files fills in as it is scrolled without flooding
 * the server. A failed batch marks its files failed; asking again retries them.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** The most paths one `loadPatches` call takes (the contract's limit is 50). */
export const BATCH_SIZE = 25;

/** `missing`: bb answered without a patch for the file (it changed or left the diff meanwhile). */
export type PatchState = "loading" | "failed" | "missing";

/** `load` puts the patches it got in place and returns the paths it got them for. */
export function usePatchLoader(load: (paths: string[]) => Promise<string[]>, resetKey: string) {
  const [current, setCurrent] = useState<{ key: string; states: ReadonlyMap<string, PatchState> }>({ key: resetKey, states: new Map() });
  const keyRef = useRef(resetKey);
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  // A new view (another target, a reload) starts with nothing asked for. This resets during render,
  // before the files' effects ask for their patches: an effect here would run after them and wipe
  // their asks, leaving those files waiting until they scrolled away and back.
  if (current.key !== resetKey) {
    keyRef.current = resetKey;
    queue.current = [];
    setCurrent({ key: resetKey, states: new Map() });
  }
  const states = current.key === resetKey ? current.states : NO_STATES;

  /** Changes the states of view `key`; an answer for a view since replaced is dropped. */
  const update = useCallback((key: string, change: (states: ReadonlyMap<string, PatchState>) => ReadonlyMap<string, PatchState>) => {
    setCurrent((previous) => (previous.key === key ? { key, states: change(previous.states) } : previous));
  }, []);

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (queue.current.length > 0) {
        const key = keyRef.current;
        const batch = queue.current.splice(0, BATCH_SIZE);
        try {
          const loaded = new Set(await loadRef.current(batch));
          update(key, (previous) => withState(without(previous, batch), batch.filter((path) => !loaded.has(path)), "missing"));
        } catch {
          update(key, (previous) => withState(previous, batch, "failed"));
        }
      }
    } finally {
      busy.current = false;
    }
  }, [update]);

  const request = useCallback(
    (path: string) => {
      if (queue.current.includes(path)) return;
      queue.current.push(path);
      update(keyRef.current, (previous) => withState(previous, [path], "loading"));
      // Let every file that came into view in the same frame join this batch.
      setTimeout(() => void pump(), 0);
    },
    [pump, update],
  );

  return { states, request };
}

const NO_STATES: ReadonlyMap<string, PatchState> = new Map();

function withState(map: ReadonlyMap<string, PatchState>, paths: readonly string[], state: PatchState): Map<string, PatchState> {
  const next = new Map(map);
  for (const path of paths) next.set(path, state);
  return next;
}

function without(map: ReadonlyMap<string, PatchState>, paths: readonly string[]): Map<string, PatchState> {
  const next = new Map(map);
  for (const path of paths) next.delete(path);
  return next;
}

/**
 * Calls `onNear` once the element comes within a screen or so of the visible part of `root` (the
 * tab's scroll container; null means the viewport). Where the browser has no IntersectionObserver, it
 * calls it at once.
 */
export function useNearScreen(ref: RefObject<Element | null>, root: Element | null, active: boolean, onNear: () => void): void {
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  useEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === "undefined") {
      onNearRef.current();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onNearRef.current();
        }
      },
      { root, rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root, active]);
}
