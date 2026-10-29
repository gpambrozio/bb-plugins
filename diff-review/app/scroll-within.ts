/**
 * Scrolling the tab's own scroll area, and nothing else. `Element.scrollIntoView` scrolls every
 * ancestor that can scroll, bb's containers around the tab included (even an `overflow: hidden` one):
 * in a real panel it moved the tab's toolbar out of sight. Every reveal and comment step scrolls here.
 */

/** Where in `root` to put `element`: its top at the top, its middle in the middle, or as little as shows it. */
export type ScrollBlock = "start" | "center" | "nearest";

/** How far `root` must scroll for `element` (inside it, shadow roots included) to sit at `block`. */
export function scrollDelta(element: Element, root: Element, block: ScrollBlock): number {
  const box = element.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  if (block === "start") return box.top - view.top;
  if (block === "center") return box.top + box.height / 2 - (view.top + view.height / 2);
  if (box.top < view.top) return box.top - view.top;
  // Below: bring its bottom up, but never its top above the view's.
  if (box.bottom > view.bottom) return Math.min(box.bottom - view.bottom, box.top - view.top);
  return 0;
}

/** Scrolls `root`, only it, so `element` sits at `block`. */
export function scrollWithin(root: Element, element: Element, block: ScrollBlock): void {
  const delta = scrollDelta(element, root, block);
  if (Math.abs(delta) >= 1) root.scrollTop += delta;
}
