// Whether something of bb's is drawn over the rail. bb's compact sidebar drawer does not cover the
// page: it slides the page sideways and lays a transparent tap-to-close layer over everything, so
// the rail would sit on top of the shifted thread. The rail is stacked under every such layer bb has
// (see RAIL_Z_INDEX) and steps aside while one is there.
//
// This is a hit test of the page, not a read of bb's markup: it asks the browser what is topmost at
// each button's centre and names no bb element or class.
import { useEffect, useState, type RefObject } from "react";

export type HitTest = (x: number, y: number) => Element | null;

/** True when the topmost element at the centre of any of the rail's buttons is not part of the rail. */
export function isCovered(rail: Element, hitTest: HitTest): boolean {
  for (const button of Array.from(rail.querySelectorAll("button"))) {
    const box = button.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const top = hitTest(box.left + box.width / 2, box.top + box.height / 2);
    if (top === null || !rail.contains(top)) return true;
  }
  return false;
}

/**
 * Re-checks after any change to the page's elements (a drawer, dialog or menu mounting, or one
 * opening or closing), at most once a frame, and on resize.
 */
export function useCovered(rail: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setCovered(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const element = rail.current;
      if (element !== null) setCovered(isCovered(element, (x, y) => document.elementFromPoint(x, y)));
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
  }, [rail, enabled]);

  return covered;
}
