/**
 * A textarea that grows with what is typed in it and shrinks back when words are removed or sent. The
 * textarea's own CSS sets the bounds: a `min-h-*` for the empty box and a `max-h-*` past which it scrolls
 * (give it `overflow-y-auto`).
 *
 * Where the browser has CSS `field-sizing: content` (Chromium, so bb's desktop app), the browser sizes the
 * box itself and this hook does nothing per keystroke. Elsewhere it measures, at most once per frame, inside
 * the layout that frame does anyway: a box whose text only grew is read without resetting its height, and the
 * reset that lets it shrink happens only after a change that was not an insertion, or a change of width.
 * Resetting and reading synchronously on every keystroke tripled the layouts per key and made typing lag.
 */
import { useCallback, useEffect, useRef } from "react";

export function useAutoGrow(value: string): (element: HTMLTextAreaElement | null) => void {
  const sizer = useRef<Sizer | null>(null);

  const ref = useCallback((element: HTMLTextAreaElement | null) => {
    // React calls this with null on unmount, which ends the observer and any frame still asked for.
    sizer.current?.dispose();
    sizer.current = element === null ? null : attach(element);
  }, []);

  useEffect(() => {
    sizer.current?.changed(value);
  }, [value]);

  return ref;
}

interface Sizer {
  /** The text is now `value`. */
  changed(value: string): void;
  dispose(): void;
}

/** Whether the browser sizes a textarea to its content by itself. */
export function sizesByCss(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
}

function attach(element: HTMLTextAreaElement): Sizer {
  if (sizesByCss()) {
    element.style.setProperty("field-sizing", "content");
    return { changed: () => {}, dispose: () => {} };
  }

  const style = window.getComputedStyle(element);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  let previous = element.value;
  let shrink = true;
  let frame: number | null = null;
  let width = element.clientWidth;

  const fit = () => {
    frame = null;
    if (shrink) element.style.height = "auto";
    shrink = false;
    const height = `${element.scrollHeight + border}px`;
    if (element.style.height !== height) element.style.height = height;
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(fit);
  };

  // Only a change of width rewraps the text; the height is this hook's own doing.
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (element.clientWidth === width) return;
          width = element.clientWidth;
          shrink = true;
          schedule();
        });
  observer?.observe(element);
  schedule();

  return {
    changed(value) {
      // Text inserted at one place, as typing does, cannot wrap onto fewer lines; any other change (a
      // deletion, a paste over a selection) may.
      if (!isInsertion(previous, value)) shrink = true;
      previous = value;
      schedule();
    },
    dispose() {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

/** Whether `next` is `previous` with text added at one place and nothing removed. */
export function isInsertion(previous: string, next: string): boolean {
  if (next.length <= previous.length) return false;
  let start = 0;
  while (start < previous.length && previous[start] === next[start]) start += 1;
  let end = 0;
  while (end < previous.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  return start + end === previous.length;
}
