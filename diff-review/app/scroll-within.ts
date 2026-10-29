/**
 * Scrolling the tab's own scroll area, and nothing else. `Element.scrollIntoView` scrolls every
 * ancestor that can scroll, bb's containers around the tab included (even an `overflow: hidden` one):
 * in a real panel it moved the tab's toolbar out of sight. Every reveal and comment step scrolls here.
 *
 * A place scrolled to is then held while the layout settles. Patches load and diffs draw as their
 * files come near the screen, and a file that grows above the place pushes it down: Chromium's own
 * scroll anchoring keeps a node of the file in view still, and when the file that grows is in view,
 * that node is in it.
 */

/** Where in `root` to put `element`: its top at the top, its middle in the middle, or as little as shows it. */
export type ScrollBlock = "start" | "center" | "nearest";

/** A hold ends once the layout has left the place alone this long… */
const SETTLE_MS = 3_000;
/** …and after this long in any case. */
const HOLD_MAX_MS = 15_000;
/** The user taking over ends a hold at once. */
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** The hold on each scroll area, to end it when another starts. */
const holds = new WeakMap<Element, () => void>();

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

/**
 * Keeps `root` at a place while the layout settles around it: on each frame `drift()` says how far the
 * place has moved down (null once it is gone) and `root` scrolls after it. It ends once nothing moved
 * the place for a while, when the user scrolls, clicks or types in `root`, or when another hold on
 * `root` starts; `onEnd` runs then. Returns a function that ends it.
 */
export function holdWithin(root: Element, drift: () => number | null, onEnd?: () => void): () => void {
  holds.get(root)?.();
  if (typeof requestAnimationFrame !== "function") {
    onEnd?.();
    return () => undefined;
  }
  const started = performance.now();
  let moved = started;
  let frame = 0;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(frame);
    for (const type of USER_INPUT) root.removeEventListener(type, end);
    if (holds.get(root) === end) holds.delete(root);
    onEnd?.();
  };
  const hold = () => {
    const now = performance.now();
    const delta = root.isConnected ? drift() : null;
    if (delta === null) return end();
    if (Math.abs(delta) >= 1) {
      const before = root.scrollTop;
      root.scrollTop += delta;
      // At either end of the area there is nowhere to go: that is not the layout still moving.
      if (root.scrollTop !== before) moved = now;
    }
    if (now - moved > SETTLE_MS || now - started > HOLD_MAX_MS) return end();
    frame = requestAnimationFrame(hold);
  };
  for (const type of USER_INPUT) root.addEventListener(type, end, { passive: true });
  holds.set(root, end);
  frame = requestAnimationFrame(hold);
  return end;
}

/** Scrolls `root`, only it, so `element` sits at `block`, and holds it there while the layout settles. */
export function scrollWithin(root: Element, element: Element, block: ScrollBlock): void {
  const delta = scrollDelta(element, root, block);
  if (Math.abs(delta) >= 1) root.scrollTop += delta;
  const top = () => element.getBoundingClientRect().top - root.getBoundingClientRect().top;
  const at = top();
  holdWithin(root, () => (element.isConnected ? top() - at : null));
}
