/**
 * Bringing a place in the diff into view, for find, "Go to" and the next/previous comment commands.
 * Pierre draws each file's diff in an open shadow root whose rows carry `data-line` (the line's
 * number on its side) and `data-line-type`; a removed line is `change-deletion`, on the old side.
 */
import type { Side } from "../shared/types";
import { scrollWithin } from "./scroll-within";

/** A place to show: a file's line, or with `line` 0 its header. `seq` makes each ask a new one. */
export interface Reveal {
  path: string;
  side: Side;
  line: number;
  seq: number;
}

function lineElement(section: Element, side: Side, line: number): Element | null {
  const selector = side === "old" ? `[data-line="${line}"][data-line-type="change-deletion"]` : `[data-line="${line}"]:not([data-line-type="change-deletion"])`;
  const elements = section.querySelectorAll("*");
  for (let index = 0; index < elements.length; index++) {
    const found = elements[index]!.shadowRoot?.querySelector(selector);
    if (found !== null && found !== undefined) return found;
  }
  return section.querySelector(selector);
}

/** Scrolls the line into the middle of `root`, or the file's header to its top when not drawn. */
export function revealIn(root: Element, section: Element, side: Side, line: number): void {
  const row = line > 0 ? lineElement(section, side, line) : null;
  if (row !== null) scrollWithin(root, row, "center");
  else scrollWithin(root, section, "start");
}
