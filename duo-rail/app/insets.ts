// The page's safe-area insets and height, live. The SDK hands an overlay neither, so they are read
// the way bb's own CSS reads them: `env(safe-area-inset-*)`, through an invisible probe element.
import { useEffect, useState, type RefObject } from "react";

import type { Insets } from "../shared/placement";

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The probe's style: its padding is the four insets, so its border box changes when any of them does. */
export const PROBE_STYLE = {
  position: "fixed",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  visibility: "hidden",
  pointerEvents: "none",
  paddingTop: "env(safe-area-inset-top, 0px)",
  paddingRight: "env(safe-area-inset-right, 0px)",
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
  paddingLeft: "env(safe-area-inset-left, 0px)",
} as const;

export function readInsets(element: Element): Insets {
  const style = getComputedStyle(element);
  const px = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}

function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export interface Viewport {
  insets: Insets;
  height: number;
}

/**
 * Re-reads on a window resize (folding, unfolding and rotating all resize the page) and whenever the
 * probe's box changes, which catches an inset change that comes without a resize.
 */
export function useViewport(probe: RefObject<HTMLElement | null>): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => ({ insets: ZERO_INSETS, height: typeof window === "undefined" ? 0 : window.innerHeight }));

  useEffect(() => {
    const element = probe.current;
    if (element === null) return;
    const read = () => {
      const insets = readInsets(element);
      const height = window.innerHeight;
      setViewport((previous) => (previous.height === height && sameInsets(previous.insets, insets) ? previous : { insets, height }));
    };
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(element, { box: "border-box" });
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
      observer?.disconnect();
    };
  }, [probe]);

  return viewport;
}
