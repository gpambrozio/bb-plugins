// Whether the rail should step aside. bb leaves the strip empty: its page, and the full-page tool panel
// it opens over the page on a compact screen, both pad themselves out of it, and the rail is stacked over
// both (see RAIL_Z_INDEX). Two things put something of bb's where the rail is, and the rail hides for them:
// - a layer over the rail (a toast, dialog, sheet or menu), which is the topmost thing at a button;
// - bb's compact sidebar drawer. It does not cover the page but slides it sideways and lays a transparent
//   tap-to-close layer over everything, under the rail. The page's own content then sits in the strip,
//   under that layer, so the rail would sit over the shifted thread and catch the taps meant to close the
//   drawer.
//
// So the test is: at each button's centre, is the topmost thing that is not the rail inside an element
// whose padding on the strip's side is the strip, and does that padding reach the button? Or is it only
// the document itself? Then bb has left that spot empty for the rail. It is a hit test of the page plus
// computed padding, not a read of bb's markup: it names no bb element or class.
import { useEffect, useState, type RefObject } from "react";

import type { RailSide } from "../shared/placement";

/** Every element at a point, topmost first, as `document.elementsFromPoint` gives them. */
export type StackAt = (x: number, y: number) => Element[];
export type PaddingOf = (element: Element, side: RailSide) => number;

export interface Strip {
  side: RailSide;
  /** The strip's width: padding at least this wide leaves the whole strip empty. */
  width: number;
}

const computedPadding: PaddingOf = (element, side) => parseFloat(getComputedStyle(element)[side === "right" ? "paddingRight" : "paddingLeft"]) || 0;

/** True when `x` falls in padding on the strip's side of `element` or one of its ancestors, as wide as the strip. */
export function leavesStripEmpty(element: Element, x: number, strip: Strip, paddingOf: PaddingOf = computedPadding): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const padding = paddingOf(node, strip.side);
    // Half a point of slack: insets and padding can round differently.
    if (padding < strip.width - 0.5) continue;
    const box = node.getBoundingClientRect();
    if (strip.side === "right" ? x >= box.right - padding && x <= box.right : x >= box.left && x <= box.left + padding) return true;
  }
  return false;
}

/** True when, at the centre of any of the rail's buttons, what lies under the rail is not space bb left empty. */
export function isCovered(rail: Element, strip: Strip, stackAt: StackAt, paddingOf?: PaddingOf): boolean {
  for (const button of Array.from(rail.querySelectorAll("button"))) {
    const box = button.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const x = box.left + box.width / 2;
    const under = stackAt(x, box.top + box.height / 2).find((element) => !rail.contains(element));
    // Nothing at all: the button is off screen.
    if (under === undefined) return true;
    // Only the document itself: nothing of bb's there takes the pointer, as while a menu (the rail's own
    // More, on the wide layout) has set the page's `pointer-events: none`.
    if (under === rail.ownerDocument.documentElement || under === rail.ownerDocument.body) continue;
    if (!leavesStripEmpty(under, x, strip, paddingOf)) return true;
  }
  return false;
}

/**
 * Re-checks after any change to the page's elements (a drawer, dialog, panel or menu mounting, or one
 * opening or closing), at most once a frame, and on resize.
 */
export function useCovered(rail: RefObject<HTMLElement | null>, strip: Strip | null): boolean {
  const [covered, setCovered] = useState(false);
  const side = strip?.side;
  const width = strip?.width;

  useEffect(() => {
    if (side === undefined || width === undefined) {
      setCovered(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const element = rail.current;
      if (element !== null) setCovered(isCovered(element, { side, width }, (x, y) => document.elementsFromPoint(x, y)));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "style", "class"] });
    window.addEventListener("resize", schedule);
    // A transition that ends without changing an attribute (a drawer sliding shut) still changes what is on top.
    document.addEventListener("transitionend", schedule, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", schedule, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [rail, side, width]);

  return covered;
}
