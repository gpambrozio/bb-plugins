// Debug numbers, drawn in the strip just above the rail's top button: everything the page can read
// about the screen, live. They showed that nothing the page reads changes with what the Dynamic Island
// shows (a Live Activity or only the clock), which is why the rail now stands on the bottom of the
// strip. Behind the "Show debug numbers" setting (DEBUG_SETTING), off by default. To take it out:
// delete this file, its line in rail.tsx and the setting.
//
// Laid out of the column's flow, so turning them on moves no button. Not at the very top of the strip:
// the island and the status icons cover that, and the text showed only a letter or two beside them.
import { useEffect, useState, type CSSProperties, type RefObject } from "react";

import type { Display } from "../shared/layout";
import type { Insets } from "../shared/placement";
import { readInsets, ZERO_INSETS } from "./insets";

/** Inset changes may come with no event at all, so the numbers are also read on this timer. */
export const DEBUG_INTERVAL_MS = 500;

export interface DebugNumbers {
  insets: Insets;
  inner: { width: number; height: number };
  visual: { width: number; height: number; offsetTop: number; offsetLeft: number } | null;
  screen: { width: number; height: number };
  devicePixelRatio: number;
}

export function readDebugNumbers(probe: Element | null): DebugNumbers {
  const visual = window.visualViewport;
  return {
    insets: probe === null ? ZERO_INSETS : readInsets(probe),
    inner: { width: window.innerWidth, height: window.innerHeight },
    visual: visual == null ? null : { width: visual.width, height: visual.height, offsetTop: visual.offsetTop, offsetLeft: visual.offsetLeft },
    screen: { width: window.screen.width, height: window.screen.height },
    devicePixelRatio: window.devicePixelRatio,
  };
}

/** At most one decimal, none when whole: 466, 466.3. */
const n = (value: number) => String(Math.round(value * 10) / 10);
const size = (width: number, height: number) => `${n(width)}×${n(height)}`;

/** The readout's lines: at most 15 characters, so each fits the 84 pt strip whole at 8 px monospace. */
export function debugLines(numbers: DebugNumbers, context: { display: Display; gap: number }): string[] {
  const { insets, inner, visual, screen } = numbers;
  return [
    context.display,
    `gap ${n(context.gap)}`,
    `inset t${n(insets.top)} r${n(insets.right)}`,
    `inset b${n(insets.bottom)} l${n(insets.left)}`,
    `win ${size(inner.width, inner.height)}`,
    visual === null ? "vv none" : `vv ${size(visual.width, visual.height)}`,
    visual === null ? "" : `vv@ t${n(visual.offsetTop)} l${n(visual.offsetLeft)}`,
    `scr ${size(screen.width, screen.height)}`,
    `dpr ${n(numbers.devicePixelRatio)}`,
  ].filter((line) => line !== "");
}

function sameNumbers(a: DebugNumbers, b: DebugNumbers): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read on every event that could carry a change, and every DEBUG_INTERVAL_MS in case none does. */
export function useDebugNumbers(probe: RefObject<HTMLElement | null>): DebugNumbers {
  const [numbers, setNumbers] = useState(() => readDebugNumbers(probe.current));
  useEffect(() => {
    const read = () => {
      const next = readDebugNumbers(probe.current);
      setNumbers((previous) => (sameNumbers(previous, next) ? previous : next));
    };
    read();
    const visual = window.visualViewport;
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    document.addEventListener("visibilitychange", read);
    visual?.addEventListener("resize", read);
    visual?.addEventListener("scroll", read);
    const timer = window.setInterval(read, DEBUG_INTERVAL_MS);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
      document.removeEventListener("visibilitychange", read);
      visual?.removeEventListener("resize", read);
      visual?.removeEventListener("scroll", read);
      window.clearInterval(timer);
    };
  }, [probe]);
  return numbers;
}

/**
 * Above the rail's top button, as wide as the strip, out of the column's flow. A line that would still
 * not fit wraps instead of being cut, so every value stays whole.
 */
const READOUT_STYLE: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  left: 0,
  right: 0,
  marginBottom: 4,
  padding: "0 2px",
  fontSize: 8,
  lineHeight: "10px",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  pointerEvents: "none",
};

export function DebugReadout({ probe, display, gap }: { probe: RefObject<HTMLElement | null>; display: Display; gap: number }) {
  const numbers = useDebugNumbers(probe);
  return (
    <div data-testid="duo-rail-debug" aria-hidden style={READOUT_STYLE} className="font-mono text-muted-foreground">
      {debugLines(numbers, { display, gap }).map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}
