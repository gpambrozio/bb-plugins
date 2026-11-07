/**
 * The captain's unsent words on a card — its Answer box, its open Steer or Relaunch line, a worker's Note —
 * kept in this browser's storage, so leaving the first mate's thread (which unmounts the board) and coming
 * back finds them where they were. A per-viewer convenience, like the folds: nothing goes to the server.
 *
 * - One entry, `DRAFTS_KEY`, maps a card's id (`cardSubject`: its task id, or its thread id when it has
 *   none) to its lines, each stamped with when it was last written.
 * - A line is written on every edit and removed when it is emptied, cancelled or sent. The write goes to
 *   storage even after the card has unmounted, so a send that lands once the board is gone still clears it.
 * - Old words go: a line older than `DRAFT_KEEP_MS` is ignored and dropped, and the board drops the lines of
 *   every card it no longer shows (`pruneDrafts`).
 * - Storage that is missing, full, blocked or holds something unreadable is no drafts at all: every access
 *   is in try/catch, and the lines keep working for as long as the card is mounted.
 */
import { useCallback, useState } from "react";

export const DRAFTS_KEY = "firstmate.drafts";
/** Unsent words older than this are dropped. */
export const DRAFT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Which line on a card: the Answer box, the worker's Steer or Relaunch line, or the worker's Note. */
export type DraftSlot = "answer" | "worker" | "note";
export interface Draft {
  text: string;
  /** Which of the worker's lines was open (the `worker` slot only). */
  kind?: "steer" | "relaunch";
}
type Entry = Draft & { at: number };
type Stored = Record<string, Partial<Record<DraftSlot, Entry>>>;

const SLOTS: readonly DraftSlot[] = ["answer", "worker", "note"];

/** This browser's storage, or null where even reaching it throws (a sandboxed or private page). */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.text === "string" &&
    typeof entry.at === "number" &&
    (entry.kind === undefined || entry.kind === "steer" || entry.kind === "relaunch")
  );
}

/** Every readable, unexpired line in storage; anything else is left out. */
function load(storage: Storage | null, now: number): Stored {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(DRAFTS_KEY) ?? null;
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const stored: Stored = {};
  for (const [card, lines] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof lines !== "object" || lines === null) continue;
    const kept: Partial<Record<DraftSlot, Entry>> = {};
    for (const slot of SLOTS) {
      const entry = (lines as Record<string, unknown>)[slot];
      if (isEntry(entry) && entry.text !== "" && now - entry.at <= DRAFT_KEEP_MS) kept[slot] = entry;
    }
    if (Object.keys(kept).length > 0) stored[card] = kept;
  }
  return stored;
}

function save(storage: Storage | null, stored: Stored): void {
  try {
    storage?.setItem(DRAFTS_KEY, JSON.stringify(stored));
  } catch {
    // Full or blocked: the words live on in the card for as long as it is mounted.
  }
}

/** A card's unsent line, or null when there is none, it has expired or storage cannot be read. */
export function readDraft(storage: Storage | null, card: string, slot: DraftSlot, now = Date.now()): Draft | null {
  const entry = load(storage, now)[card]?.[slot];
  if (entry === undefined) return null;
  return entry.kind === undefined ? { text: entry.text } : { text: entry.text, kind: entry.kind };
}

/** Keeps a card's line, or removes it when `draft` is null or empty. */
export function writeDraft(storage: Storage | null, card: string, slot: DraftSlot, draft: Draft | null, now = Date.now()): void {
  const stored = load(storage, now);
  const lines = { ...stored[card] };
  if (draft === null || draft.text === "") delete lines[slot];
  else lines[slot] = { ...draft, at: now };
  if (Object.keys(lines).length === 0) delete stored[card];
  else stored[card] = lines;
  save(storage, stored);
}

/** Drops expired and unreadable lines and, when `shown` is given, every card's that is not in it. */
export function pruneDrafts(storage: Storage | null, shown: ReadonlySet<string> | null, now = Date.now()): void {
  const stored = load(storage, now);
  for (const card of Object.keys(stored)) if (shown !== null && !shown.has(card)) delete stored[card];
  let raw: string | null = null;
  try {
    raw = storage?.getItem(DRAFTS_KEY) ?? null;
  } catch {
    return;
  }
  const next = JSON.stringify(stored);
  if (raw !== null && raw !== next) save(storage, stored);
}

/**
 * A card's line as component state, restored from storage on mount (and when the card's id changes) and
 * written back on every change.
 */
export function useCardDraft(card: string, slot: DraftSlot): [Draft | null, (next: Draft | null) => void] {
  const [state, setState] = useState(() => ({ card, draft: readDraft(browserStorage(), card, slot) }));
  let current = state;
  if (state.card !== card) {
    // The same component now shows another card: start from that card's words.
    current = { card, draft: readDraft(browserStorage(), card, slot) };
    setState(current);
  }
  const set = useCallback(
    (next: Draft | null) => {
      writeDraft(browserStorage(), card, slot, next);
      setState({ card, draft: next });
    },
    [card, slot],
  );
  return [current.draft, set];
}
