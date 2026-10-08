/**
 * The two browser objects a session is made of, behind one seam so the page's
 * tests can swap them: the WebSocket to the relay and noVNC's RFB client on
 * top of it. The page opens the socket itself to learn how it closed; noVNC
 * only says whether it closed cleanly.
 */
import RFB from "@novnc/novnc";

export type Rfb = RFB;

export function openRelaySocket(url: string): WebSocket {
  return new WebSocket(url);
}

export function createRfb(target: HTMLElement, socket: WebSocket): Rfb {
  const rfb = new RFB(target, socket, { shared: true });
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = "transparent";
  // No showDotCursor: macOS sends no cursor shape noVNC can draw, and LOCAL_CURSOR_CSS
  // (session-store.ts) shows the ordinary arrow in its place.
  return rfb;
}
