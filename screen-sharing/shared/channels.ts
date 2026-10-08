/**
 * What the app and the server share at run time: the WebSocket route, the
 * realtime channel and the shapes pushed on it. No SDK import, so the app may
 * import this file as a value.
 */
import { z } from "zod";

export const PLUGIN_ID = "screen-sharing";

/** The relay's route, under `/api/v1/plugins/<id>/http`. */
export const VNC_ROUTE = "/vnc";

/** How long a session may sit idle, and last at most, before the server ends it. */
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
 * Whether the server's Mac can be reached.
 * - `ready`: something answers on port 5900 with an RFB greeting.
 * - `off`: macOS says Screen Sharing is disabled, and nothing answers.
 * - `not-listening`: nothing answers, though macOS does not say it is off.
 * - `unsupported`: the bb server is not running on macOS.
 */
export const ScreenStateSchema = z.enum(["ready", "off", "not-listening", "unsupported"]);

export type ScreenState = z.infer<typeof ScreenStateSchema>;

export const ScreenStatusSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  state: ScreenStateSchema,
  /** The server's RFB version line, e.g. "RFB 003.889", when it answered. */
  rfbVersion: z.string().nullable(),
  /** The RFB security types the server offered, in its order. */
  securityTypes: z.array(z.number().int()),
  /** False when the server offers no sign-in method noVNC knows. */
  signInSupported: z.boolean(),
});

export type ScreenStatus = z.infer<typeof ScreenStatusSchema>;
