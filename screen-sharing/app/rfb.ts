/**
 * The two browser objects a session is made of, behind one seam so the page's
 * tests can swap them: the WebSocket to the relay and noVNC's RFB client on
 * top of it. The page opens the socket itself to learn how it closed; noVNC
 * only says whether it closed cleanly.
 */
import RFB from "@novnc/novnc";

import { REMOTE_CURSOR_ATTRIBUTE } from "./cursor";

export type Rfb = RFB;

export function openRelaySocket(url: string): WebSocket {
  return new WebSocket(url);
}

/**
 * Marks `target` once the server sends a cursor shape — any shape, an empty
 * one included. noVNC raises no event for that, so this wraps its private
 * `_updateCursor`, which both cursor encodings (Cursor and VMware cursor) call
 * in the pinned noVNC 1.7.0. `app/novnc-session.test.ts` sends real cursor
 * rectangles through it, so a noVNC that renames it fails there.
 */
function markRemoteCursor(rfb: Rfb, target: HTMLElement): void {
  const internals = rfb as unknown as { _updateCursor?: (...args: unknown[]) => unknown };
  const update = internals._updateCursor;
  if (typeof update !== "function") return;
  internals._updateCursor = function (this: unknown, ...args: unknown[]) {
    target.setAttribute(REMOTE_CURSOR_ATTRIBUTE, "");
    return update.apply(this, args);
  };
}

export function createRfb(target: HTMLElement, socket: WebSocket): Rfb {
  // A new connection starts with no cursor from the server.
  target.removeAttribute(REMOTE_CURSOR_ATTRIBUTE);
  const rfb = new RFB(target, socket, { shared: true });
  markRemoteCursor(rfb, target);
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = "transparent";
  // No showDotCursor: macOS sends no cursor shape noVNC can draw, and LOCAL_CURSOR_CSS
  // (cursor.ts) shows the ordinary arrow in its place.
  return rfb;
}
