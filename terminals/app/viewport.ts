/**
 * Where a terminal was scrolled to when the page left it, kept so that it
 * still points at the same text when the page comes back.
 *
 * A row number does not: once the scrollback is full, every new line trims
 * the oldest one and the rows shift up, so restoring the old number would
 * jump forward by however many lines arrived while the page was away. An
 * xterm marker moves with its line as lines are trimmed.
 */
import type { IMarker, Terminal } from "@xterm/xterm";

/** The view's place: null when it follows the output, else a marker on its top line. */
export type ViewportPlace = IMarker | null;

export function rememberViewport(term: Terminal): ViewportPlace {
  const buffer = term.buffer.active;
  if (buffer.viewportY >= buffer.baseY) return null;
  // A marker's offset counts from the cursor's line.
  return term.registerMarker(buffer.viewportY - (buffer.baseY + buffer.cursorY)) ?? null;
}

export function restoreViewport(term: Terminal, place: ViewportPlace): void {
  if (place === null) {
    term.scrollToBottom();
    return;
  }
  // Its line was trimmed away with the oldest scrollback: the oldest line left is the nearest.
  term.scrollToLine(place.isDisposed ? 0 : place.line);
  place.dispose();
}
