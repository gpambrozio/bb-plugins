/**
 * The two browser objects a session is made of, behind one seam so the page's
 * tests can swap them: the WebSocket to the relay and noVNC's RFB client on
 * top of it. The page opens the socket itself to learn how it closed; noVNC
 * only says whether it closed cleanly. noVNC gets the socket through a
 * `RelayChannel` (relay-channel.ts), never directly.
 */
import RFB from "@novnc/novnc";

import { REMOTE_CURSOR_ATTRIBUTE } from "./cursor";
import { RelayChannel } from "./relay-channel";
import { WheelAccumulator } from "./wheel";

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

/**
 * Releases any mouse button noVNC still has pressed on the Mac, at the last
 * pointer position. Touch gestures (a drag, a long press) press buttons
 * through noVNC's private `_handleMouseButton` with no mouse event the store
 * could track, so this reads noVNC's own state — `_mouseButtonMask` and
 * `_mousePos` in the pinned noVNC 1.7.0. `app/novnc-session.test.ts` drives
 * real gestures through it, so a noVNC that renames them fails there.
 */
export function releaseRemoteButtons(rfb: Rfb): void {
  const internals = rfb as unknown as {
    _mouseButtonMask?: number;
    _mousePos?: { x?: number; y?: number };
    _handleMouseButton?: (x: number, y: number, mask: number) => void;
  };
  if (!internals._mouseButtonMask || typeof internals._handleMouseButton !== "function") return;
  const position = internals._mousePos ?? {};
  internals._handleMouseButton(position.x ?? 0, position.y ?? 0, 0);
}

/** The parts of noVNC 1.7.0 the wheel handler below uses. */
interface WheelInternals {
  /** noVNC's keyboard, and the keys it has sent down and not up, by `code`. */
  _keyboard?: { _keyDownList?: Record<string, number> } | null;
  _rfbConnectionState?: string;
  _canvas?: HTMLCanvasElement;
  _mouseButtonMask?: number;
  _handleMouseButton?: (x: number, y: number, mask: number) => void;
}

/** RFB button masks for a wheel step: up, down, left, right (buttons 4–7). */
const WHEEL_UP = 1 << 3;
const WHEEL_DOWN = 1 << 4;
const WHEEL_LEFT = 1 << 5;
const WHEEL_RIGHT = 1 << 6;

/**
 * Scrolls the Mac in proportion to the gesture (wheel.ts), at the speed the
 * user set (read on every event, so a change applies at once), in place of
 * noVNC's own wheel handler, which sends at most one step per event. It
 * listens on `target` in the capture phase and stops the event there, so
 * noVNC's handler on its canvas never sees it, and presses the wheel buttons
 * through noVNC's private `_handleMouseButton` (with `_mouseButtonMask`, so a
 * held button stays held), as noVNC does. `app/novnc-session.test.ts` scrolls
 * the real noVNC, so a noVNC that renames any of these fails there. One
 * event's steps go to the relay as one frame. The listener goes when the
 * connection ends.
 *
 * A trackpad pinch is no scroll: Chromium sends it as wheel events with
 * `ctrlKey` set and no key event, and scrolling the Mac by its deltas would
 * move the page there for a zoom gesture here. It is dropped — kept from
 * noVNC and from the browser's own zoom, and added to nothing — unless noVNC
 * has Control down on the Mac (its keyboard's `_keyDownList`), when the Mac
 * gets a Control-scroll, as from its own keyboard. noVNC's list is the one
 * that counts: it lets go of every key when the window loses focus, with no
 * key-up on the page.
 */
function scrollProportionally(rfb: Rfb, target: HTMLElement, channel: RelayChannel, scrollSpeed: () => number): void {
  const internals = rfb as unknown as WheelInternals;
  const steps = new WheelAccumulator();
  const listening = new AbortController();
  rfb.addEventListener("disconnect", () => listening.abort());
  /** Whether noVNC has Control down on the Mac: a real key, which a pinch never presses. */
  const controlDown = () => {
    const held = internals._keyboard?._keyDownList ?? {};
    return "ControlLeft" in held || "ControlRight" in held;
  };
  target.addEventListener(
    "wheel",
    (event) => {
      const canvas = internals._canvas;
      const press = internals._handleMouseButton;
      if (event.target !== canvas || canvas === undefined || typeof press !== "function") return;
      if (internals._rfbConnectionState !== "connected" || rfb.viewOnly) return;
      event.stopPropagation();
      event.preventDefault();
      if (event.ctrlKey && !controlDown()) return; // A pinch.
      const { x, y } = steps.add(event, scrollSpeed());
      const bounds = canvas.getBoundingClientRect();
      const atX = Math.min(Math.max(event.clientX - bounds.left, 0), Math.max(bounds.width - 1, 0));
      const atY = Math.min(Math.max(event.clientY - bounds.top, 0), Math.max(bounds.height - 1, 0));
      const held = internals._mouseButtonMask ?? 0;
      const step = (button: number, count: number) => {
        for (let i = 0; i < count; i++) {
          press.call(rfb, atX, atY, held | button);
          press.call(rfb, atX, atY, held);
        }
      };
      channel.gather(() => {
        step(x < 0 ? WHEEL_LEFT : WHEEL_RIGHT, Math.abs(x));
        step(y < 0 ? WHEEL_UP : WHEEL_DOWN, Math.abs(y));
      });
    },
    { capture: true, passive: false, signal: listening.signal },
  );
}

/** `scrollSpeed` is read on every wheel event: the "Scroll speed" setting, 1 to 5. */
export function createRfb(target: HTMLElement, socket: WebSocket, scrollSpeed: () => number): Rfb {
  // A new connection starts with no cursor from the server.
  target.removeAttribute(REMOTE_CURSOR_ATTRIBUTE);
  const channel = new RelayChannel(socket);
  const rfb = new RFB(target, channel as unknown as WebSocket, { shared: true });
  markRemoteCursor(rfb, target);
  scrollProportionally(rfb, target, channel, scrollSpeed);
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = "transparent";
  // No showDotCursor: macOS sends no cursor shape noVNC can draw, and LOCAL_CURSOR_CSS
  // (cursor.ts) shows the ordinary arrow in its place.
  return rfb;
}
