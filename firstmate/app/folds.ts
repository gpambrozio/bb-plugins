/**
 * Which board columns the captain has folded shut, kept in the browser's storage so a fold survives a
 * reload. A missing, unreadable or malformed entry is no folds at all — the board opens fully.
 */
import { COLUMN_IDS, type ColumnId } from "../shared/types";

const FOLDS_KEY = "firstmate.folds";

function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && (COLUMN_IDS as readonly string[]).includes(value);
}

export function readFolds(storage: Pick<Storage, "getItem">): Set<ColumnId> {
  const raw = storage.getItem(FOLDS_KEY);
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-edited or truncated entry: start over rather than fail the board.
    return new Set();
  }
  return Array.isArray(parsed) ? new Set(parsed.filter(isColumnId)) : new Set();
}

/** Folds the column if it is open, opens it if it is folded; returns the folds now in force. */
export function toggleFold(storage: Storage, column: ColumnId): Set<ColumnId> {
  const folds = readFolds(storage);
  if (folds.has(column)) folds.delete(column);
  else folds.add(column);
  storage.setItem(FOLDS_KEY, JSON.stringify([...folds]));
  return folds;
}
