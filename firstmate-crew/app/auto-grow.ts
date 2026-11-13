/**
 * A textarea that grows with what is typed in it and shrinks back when words are removed or sent. The
 * textarea's own CSS sets the bounds: a `min-h-*` for the empty box and a `max-h-*` past which it scrolls
 * (give it `overflow-y-auto`).
 *
 * Where the browser has CSS `field-sizing: content` (Chromium, so bb's desktop app), the browser sizes the
 * box itself and this hook does nothing per keystroke. Elsewhere it measures, at most once per frame, inside
 * the layout that frame does anyway. Letters typed at the end are read without resetting its height; any
 * other change, and a change of width, resets it first so the box can shrink.
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
      if (!isAppend(previous, value)) shrink = true;
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

/**
 * Whether `next` is `previous` with letters typed at its end: no whitespace, nothing removed, nothing added
 * anywhere else. Only that cannot make the text wrap onto fewer lines; a space typed inside a long word, any
 * other edit inside the text, or a paste over a selection can.
 */
export function isAppend(previous: string, next: string): boolean {
  return next.length > previous.length && next.startsWith(previous) && !/\s/.test(next.slice(previous.length));
}
