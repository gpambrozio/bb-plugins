/**
 * A textarea that grows with what is typed in it and shrinks back when words are removed or sent. Its
 * height is its content's, and the textarea's own CSS sets the bounds: a `min-h-*` for the empty box and a
 * `max-h-*` past which it scrolls (give it `overflow-y-auto`). The height is measured again when the text
 * changes and when the box's width does, since a narrower box wraps onto more lines.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

export function useAutoGrow(value: string): (element: HTMLTextAreaElement | null) => void {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: HTMLTextAreaElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    box.current = element;
    if (element === null) return;
    fit(element);
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    observer.current = new ResizeObserver(() => {
      // Only a change of width rewraps the text; the height is this hook's own doing.
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit(element);
    });
    observer.current.observe(element);
  }, []);

  useLayoutEffect(() => {
    if (box.current !== null) fit(box.current);
  }, [value]);

  return ref;
}

/** Sizes the box to its content; `scrollHeight` leaves out the border, which a border-box height includes. */
function fit(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  const style = window.getComputedStyle(element);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  element.style.height = `${element.scrollHeight + border}px`;
}
