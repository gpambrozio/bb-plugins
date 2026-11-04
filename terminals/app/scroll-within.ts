/**
 * Keeping a list's active row in sight by scrolling the list itself, never
 * with `scrollIntoView`, which scrolls every ancestor that can scroll — bb's
 * containers and the dialog around the list included.
 */

/** How far `list` must scroll for `row` (inside it) to show whole, by as little as it takes. */
export function revealDelta(row: Element, list: Element): number {
  const box = row.getBoundingClientRect();
  const view = list.getBoundingClientRect();
  if (box.top < view.top) return box.top - view.top;
  if (box.bottom > view.bottom) return Math.min(box.bottom - view.bottom, box.top - view.top);
  return 0;
}

/** Scrolls `list` so `row` shows, moving nothing else. */
export function revealWithin(row: Element, list: Element): void {
  const delta = revealDelta(row, list);
  if (delta !== 0) list.scrollTop += delta;
}

/** How far `strip` must scroll sideways for `item` (inside it) to show whole, by as little as it takes. */
export function revealDeltaX(item: Element, strip: Element): number {
  const box = item.getBoundingClientRect();
  const view = strip.getBoundingClientRect();
  if (box.left < view.left) return box.left - view.left;
  if (box.right > view.right) return Math.min(box.right - view.right, box.left - view.left);
  return 0;
}

/** Scrolls `strip` sideways so `item` shows, moving nothing else. */
export function revealWithinX(item: Element, strip: Element): void {
  const delta = revealDeltaX(item, strip);
  if (delta !== 0) strip.scrollLeft += delta;
}
