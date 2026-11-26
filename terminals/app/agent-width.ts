/**
 * The agent panel's width beside the terminal: what a drag or the arrow keys
 * may set it to, and remembering it in this browser (localStorage). No React.
 * The phone layout lays the panel over the terminal instead and has no width.
 */

/** The panel's width before the user sets one: bb's 28rem. */
export const DEFAULT_AGENT_WIDTH = 448;
/** Narrower than this, bb's chat and its composer stop fitting. */
export const MIN_AGENT_WIDTH = 300;
/** The terminal keeps at least this much of the row. */
export const MIN_TERMINAL_WIDTH = 240;
/** The panel takes at most this share of the row. */
export const MAX_AGENT_SHARE = 0.75;
/** How far one arrow key moves the edge; Shift moves it four times as far. */
export const KEY_STEP = 16;

const STORAGE_KEY = "terminals.agentPanelWidth";

/** The widest the panel may be in a row this wide (never below the minimum). */
export function maxAgentWidth(rowWidth: number): number {
  return Math.max(MIN_AGENT_WIDTH, Math.floor(Math.min(rowWidth * MAX_AGENT_SHARE, rowWidth - MIN_TERMINAL_WIDTH)));
}

/** `width` held between the minimum and what the row allows; a row of unknown width (0) bounds nothing above. */
export function clampAgentWidth(width: number, rowWidth: number): number {
  const max = rowWidth > 0 ? maxAgentWidth(rowWidth) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(max, Math.max(MIN_AGENT_WIDTH, width)));
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The width this browser last left the panel at, or the default. */
export function readAgentWidth(): number {
  try {
    const stored = Number(storage()?.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_AGENT_WIDTH ? Math.round(stored) : DEFAULT_AGENT_WIDTH;
  } catch {
    return DEFAULT_AGENT_WIDTH;
  }
}

/** Remembers the width in this browser; a browser that refuses storage just forgets it. */
export function saveAgentWidth(width: number): void {
  try {
    storage()?.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Private mode or blocked storage: the width lasts until the page reloads.
  }
}
