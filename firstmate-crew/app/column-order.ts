/**
 * The order the captain has put the board's columns in, kept in the browser's storage beside the folds.
 * A missing, unreadable or malformed entry is the default order; columns it lacks go after the ones it
 * names, in the default order, so a column added later still shows.
 */
import { COLUMN_IDS, type ColumnId } from "../shared/types";

const ORDER_KEY = "firstmate.order";

function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && (COLUMN_IDS as readonly string[]).includes(value);
}

export function readColumnOrder(storage: Pick<Storage, "getItem">): ColumnId[] {
  const raw = storage.getItem(ORDER_KEY);
  if (raw === null) return [...COLUMN_IDS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-edited or truncated entry: start over rather than fail the board.
    return [...COLUMN_IDS];
  }
  if (!Array.isArray(parsed)) return [...COLUMN_IDS];
  const named = [...new Set(parsed.filter(isColumnId))];
  return [...named, ...COLUMN_IDS.filter((id) => !named.includes(id))];
}

/**
 * Moves the column to just above (or below) the nearest shown column in that direction and returns the
 * order now in force. Hidden (empty) columns are skipped, so every press moves the section on screen; at
 * either end nothing changes and nothing is written.
 */
export function moveColumn(
  storage: Storage,
  column: ColumnId,
  direction: "up" | "down",
  shown: ReadonlySet<ColumnId>,
): ColumnId[] {
  const order = readColumnOrder(storage);
  const from = order.indexOf(column);
  const step = direction === "up" ? -1 : 1;
  let to = from + step;
  while (to >= 0 && to < order.length && !shown.has(order[to]!)) to += step;
  if (to < 0 || to >= order.length) return order;
  const target = order[to]!;
  order.splice(from, 1);
  order.splice(order.indexOf(target) + (direction === "up" ? 0 : 1), 0, column);
  storage.setItem(ORDER_KEY, JSON.stringify(order));
  return order;
}
