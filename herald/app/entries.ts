/**
 * The entry list, shared by everything in one window: the overlay
 * (`app/bridge.tsx`) reads it from the server and writes it here; the panel,
 * the sidebar badge and the composer banner read it through `useEntries`.
 * One read per change instead of one per component.
 */
import { useSyncExternalStore } from "react";

import type { AttentionEntry } from "../shared/herald";

export interface EntriesState {
  /** Null until the first read answers. */
  entries: AttentionEntry[] | null;
  error: string | null;
}

let state: EntriesState = { entries: null, error: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setEntries(entries: AttentionEntry[]): void {
  state = { entries, error: null };
  emit();
}

export function setEntriesError(error: string): void {
  state = { ...state, error };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEntries(): EntriesState {
  return useSyncExternalStore(subscribe, () => state);
}
