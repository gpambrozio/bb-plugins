/**
 * What the page says when a session ends: from how the relay's WebSocket
 * closed (its close code says why the server ended it) and whether macOS
 * refused the sign-in.
 */
import { CloseCode, LOST_AFTER_MS, SESSION_LIMITS } from "../shared/channels";

export interface SessionEnd {
  /** How the WebSocket closed; null when it never opened or the page closed it. */
  close: { code: number; reason: string } | null;
  /** The reason noVNC reported for a refused sign-in, if any. */
  securityFailure: string | null;
  /** Whether the session got as far as showing the screen. */
  connected: boolean;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capital = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export const CLOSED_BY_USER_MESSAGE = "Closed from bb with Close all.";

/** The relay stopped answering with its socket still open (liveness.ts): bb restarting, or the network gone. */
export const LOST_MESSAGE = `Lost the connection to bb: nothing came back for ${LOST_AFTER_MS / 1000} seconds. Connect again once bb is reachable.`;

export function endMessage(end: SessionEnd): string {
  if (end.securityFailure !== null) return `Sign-in failed: ${sentence(end.securityFailure)}`;
  const close = end.close;
  if (close === null) return "Disconnected.";
  switch (close.code) {
    case CloseCode.idle:
      return `Closed after ${SESSION_LIMITS.idleMinutes} minutes with nothing passing between bb and the Mac.`;
    case CloseCode.maxAge:
      return `Closed after ${SESSION_LIMITS.maxHours} hours, the longest a session lasts.`;
    case CloseCode.closedByUser:
      return CLOSED_BY_USER_MESSAGE;
    case CloseCode.stopping:
    case CloseCode.bbPluginReloaded:
      return "Closed because the Screen Sharing plugin stopped or reloaded.";
    case CloseCode.policy:
      return `bb refused the session${close.reason === "" ? "" : ` (${close.reason})`}. Try again.`;
    case CloseCode.failed:
      return close.reason === "" ? "The relay failed." : sentence(close.reason);
    case CloseCode.normal:
      return end.connected ? "Screen Sharing ended the session." : "Screen Sharing closed the connection before you signed in.";
    default:
      return end.connected ? "The connection was lost." : "Could not connect to the relay.";
  }
}
