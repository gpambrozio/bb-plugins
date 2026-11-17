/**
 * Whether Herald is muted on every device (`shared/mute.ts`), as this window
 * last heard from the server: read when the overlay mounts and after every
 * reconnect, and pushed on `MUTE_CHANNEL` whenever it changes. The overlay
 * (`app/bridge.tsx`) writes it; the announcer's gate and the Herald page read
 * it. Null until the first answer, when the host form's own value stands.
 *
 * Kept apart from `useSettings()`, whose copy bb re-reads on its own schedule:
 * a voice hook that mutes Herald needs every window quiet now, not later.
 */
import { useSyncExternalStore } from "react";

let muted: boolean | null = null;
const listeners = new Set<() => void>();

export function globalMuted(): boolean | null {
  return muted;
}

export function setGlobalMuted(next: boolean | null): void {
  if (next === muted) return;
  muted = next;
  for (const listener of listeners) listener();
}

export function onGlobalMuteChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGlobalMuted(): boolean | null {
  return useSyncExternalStore(onGlobalMuteChange, globalMuted);
}
