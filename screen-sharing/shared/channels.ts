/**
 * What the app and the server share at run time: the WebSocket route, the
 * realtime channel, the flow-control frames and the shapes pushed on it. No SDK import, so the app may
 * import this file as a value.
 */
import { z } from "zod";

export const PLUGIN_ID = "screen-sharing";

/** The relay's route, under `/api/v1/plugins/<id>/http`. */
export const VNC_ROUTE = "/vnc";

/**
 * Flow control between the page and the relay. The page tells the relay how
 * many bytes it has received in all, in a text frame (`ack:<bytes>`), at most
 * every `ACK_EVERY_MS`; noVNC itself sends only binary frames. The relay stops
 * reading from the Mac while more than its window is unacknowledged, so a slow
 * viewer slows the Mac down instead of filling memory on the way. The relay
 * URL says `flow=ack`, so a page from before flow control is turned away
 * instead of stalling.
 */
export const FLOW_PARAM = "flow";
export const FLOW_VERSION = "ack";
export const ACK_EVERY_MS = 50;
const ACK_PREFIX = "ack:";

export function ackFrame(totalBytes: number): string {
  return `${ACK_PREFIX}${totalBytes}`;
}

/** The byte count in an ack frame, or null for anything else. */
export function parseAck(frame: string): number | null {
  if (!frame.startsWith(ACK_PREFIX) || frame.length > 24) return null;
  const digits = frame.slice(ACK_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Liveness between the page and the relay. A socket can stay open in the
 * browser after the server behind it is gone — bb restarting behind the
 * getbb.app tunnel leaves the browser's end open — so the page does not wait
 * for a close event alone: it sends `ping` every `PING_EVERY_MS`, the relay
 * answers `pong`, and the page ends the session when a ping has gone
 * unanswered, with nothing at all from the relay, for `LOST_AFTER_MS`. noVNC
 * never sees either frame.
 */
export const PING_FRAME = "ping";
export const PONG_FRAME = "pong";
export const PING_EVERY_MS = 2_000;
export const LOST_AFTER_MS = 6_000;

/**
 * When a session ends on its own. The page disconnects after `idleMinutes`
 * without keyboard, mouse or touch input; the server ends a session after
 * `idleMinutes` with no bytes either way (a client that went away) and after
 * `maxHours` however busy.
 */
export const SESSION_LIMITS = { idleMinutes: 30, maxHours: 8 } as const;

/** Published with a `SessionList` whenever a session opens or closes. */
export const SESSIONS_CHANGED = "sessions-changed";

/**
 * Close codes the relay sends the app. 1000-range codes are the WebSocket
 * standard's; 4000-range ones say why the server ended a session itself.
 */
export const CloseCode = {
  normal: 1000,
  policy: 1008,
  failed: 1011,
  idle: 4001,
  maxAge: 4002,
  /** bb itself closes a plugin's sockets with this when the plugin reloads or is disabled. */
  bbPluginReloaded: 1012,
  closedByUser: 4003,
  stopping: 4004,
} as const;

/** One open relay session. Says nothing about what is on the screen. */
export const SessionInfoSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  openedAt: z.number(),
  lastActivityAt: z.number(),
});

export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionListSchema = z.object({ sessions: z.array(SessionInfoSchema) });

export type SessionList = z.infer<typeof SessionListSchema>;

/**
 * Whether a Mac's Screen Sharing can be reached.
 * - `ready`: something answers on its port 5900 with an RFB greeting.
 * - `off`: macOS says Screen Sharing is disabled, and nothing answers.
 * - `not-listening`: nothing answers, though macOS does not say it is off.
 * - `refused`: Screen Sharing answers but turns connections away for now
 *   (macOS does this after too many failed sign-ins, for one).
 * - `unsupported`: the machine is not a Mac.
 * - `offline`: bb has no connection to the machine right now.
 * - `unreachable`: bb is connected to it, but the check itself failed.
 */
export const ScreenStateSchema = z.enum(["ready", "off", "not-listening", "refused", "unsupported", "offline", "unreachable"]);

export type ScreenState = z.infer<typeof ScreenStateSchema>;

/** What a check finds on the machine itself; the host entry and the server's own check both answer this. */
export const ScreenCheckSchema = z.object({
  state: ScreenStateSchema,
  /** The server's RFB version line, e.g. "RFB 003.889", when it answered. */
  rfbVersion: z.string().nullable(),
  /** The RFB security types the server offered, in its order. */
  securityTypes: z.array(z.number().int()),
  /** False when the server offers no sign-in method noVNC knows. */
  signInSupported: z.boolean(),
  /** Why the server turned the probe away, when it said; only with `refused`. */
  refusedReason: z.string().nullable(),
});

export type ScreenCheck = z.infer<typeof ScreenCheckSchema>;

export const ScreenStatusSchema = ScreenCheckSchema.extend({
  hostId: z.string(),
  hostName: z.string(),
  /** The Mac running the bb server, reached over its own loopback. */
  isServer: z.boolean(),
  /** Why the check failed; only with `unreachable`. */
  unreachableReason: z.string().nullable(),
});

export type ScreenStatus = z.infer<typeof ScreenStatusSchema>;

/** One machine enrolled in this bb, as the host picker lists it. */
export const HostEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** bb has a live connection to it. */
  connected: z.boolean(),
  /** The machine running the bb server. */
  isServer: z.boolean(),
});

export type HostEntry = z.infer<typeof HostEntrySchema>;

export const HostListSchema = z.object({ hosts: z.array(HostEntrySchema) });

export type HostList = z.infer<typeof HostListSchema>;
