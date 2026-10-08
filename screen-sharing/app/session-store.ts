/**
 * The session of this bb window, kept outside React so it outlives the page.
 *
 * bb unmounts the Screen Sharing page whenever the user opens something else,
 * but keeps this module loaded for the life of the window. The session — the
 * relay's WebSocket, noVNC's client and the element noVNC draws into — lives
 * here; the page only lends that element a place on screen while it is open
 * (`ScreenMount` in vnc-session.tsx). Coming back reattaches the same live
 * connection: nothing is signed in again, and nothing about the sign-in is
 * kept to make that possible.
 *
 * The session still ends on Disconnect, on Close all and the server's own
 * limits (the relay closes the socket), when the plugin reloads (bb closes the
 * socket), when the window goes away, and after `SESSION_LIMITS.idleMinutes`
 * without a key, click, touch, wheel or pointer movement on the screen — which
 * a detached, unseen screen never gets.
 */
import { SESSION_LIMITS } from "../shared/channels";
import { endMessage, type SessionEnd } from "./end-message";
import { createRfb, openRelaySocket, type Rfb } from "./rfb";
import { relayUrl } from "./relay-url";

export type CredentialType = "username" | "password" | "target";

export type Stage =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "credentials"; types: CredentialType[] }
  | { kind: "signing-in" }
  | { kind: "connected" };

export interface ScreenSessionSnapshot {
  stage: Stage;
  /** The Mac of the current session, or of the last one. */
  hostId: string | null;
  hostName: string | null;
  viewOnly: boolean;
  /** Why the last session ended; cleared when a new one starts. */
  ended: string | null;
}

/** Asks the server for a ticket; the page passes its RPC client's `openSession`. */
export type OpenSession = (hostId: string) => Promise<{ token: string }>;

const INPUT_IDLE_MS = SESSION_LIMITS.idleMinutes * 60_000;
const INPUT_IDLE_CHECK_MS = 30_000;
/** Input on the screen that counts as someone using it. */
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/**
 * noVNC sets its canvas's CSS cursor to `none` until the server sends a
 * cursor shape, and macOS Screen Sharing sends none noVNC can draw, so the
 * pointer vanished over the screen. While noVNC says `none`, show the
 * ordinary arrow; a real remote cursor (a `url(…)` cursor) is left alone, and
 * `showDotCursor` covers a remote cursor that is fully transparent.
 */
export const LOCAL_CURSOR_CSS = `[data-screen-sharing-screen] canvas[style*="cursor: none"] { cursor: default !important; }`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ScreenSessionStore {
  private snapshot: ScreenSessionSnapshot = { stage: { kind: "idle" }, hostId: null, hostName: null, viewOnly: false, ended: null };
  private readonly listeners = new Set<() => void>();
  /** Bumped by every start and end, so late answers from an older attempt are dropped. */
  private attempt = 0;
  private socket: WebSocket | null = null;
  private rfb: Rfb | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastInput = 0;
  private screenElement: HTMLDivElement | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ScreenSessionSnapshot => this.snapshot;

  /** The element noVNC draws into. The page attaches it while open; it lives on detached otherwise. */
  get element(): HTMLDivElement {
    if (this.screenElement === null) {
      const element = document.createElement("div");
      element.dataset.screenSharingScreen = "";
      element.style.width = "100%";
      element.style.height = "100%";
      const style = document.createElement("style");
      style.textContent = LOCAL_CURSOR_CSS;
      element.append(style);
      for (const type of INPUT_EVENTS) {
        // Capture: noVNC handles these on its canvas inside the element and may stop them there.
        element.addEventListener(type, () => (this.lastInput = Date.now()), { capture: true, passive: true });
      }
      this.screenElement = element;
    }
    return this.screenElement;
  }

  get live(): boolean {
    return this.snapshot.stage.kind !== "idle";
  }

  connect({ openSession, hostId, hostName }: { openSession: OpenSession; hostId: string; hostName: string }): void {
    if (this.live) return;
    const attempt = ++this.attempt;
    this.set({ stage: { kind: "connecting" }, hostId, hostName, ended: null });
    const end: SessionEnd = { close: null, securityFailure: null, connected: false };

    openSession(hostId)
      .then(({ token }) => {
        if (attempt !== this.attempt) return;
        const socket = openRelaySocket(relayUrl(window.location.origin, hostId, token));
        this.socket = socket;
        // Registered before noVNC's own handler, so it has run when noVNC reports the disconnect.
        socket.addEventListener("close", (event) => {
          end.close = { code: event.code, reason: event.reason };
        });
        const rfb = createRfb(this.element, socket);
        this.rfb = rfb;
        rfb.viewOnly = this.snapshot.viewOnly;
        rfb.addEventListener("credentialsrequired", (event) => {
          if (attempt === this.attempt) this.set({ stage: { kind: "credentials", types: event.detail.types } });
        });
        rfb.addEventListener("securityfailure", (event) => {
          end.securityFailure = event.detail.reason ?? `macOS refused the sign-in (status ${event.detail.status})`;
        });
        rfb.addEventListener("connect", () => {
          end.connected = true;
          if (attempt !== this.attempt) return;
          this.set({ stage: { kind: "connected" } });
          this.startIdleWatch();
          this.focus();
        });
        rfb.addEventListener("disconnect", () => {
          if (attempt === this.attempt) this.finish(endMessage(end));
        });
      })
      .catch((error: unknown) => {
        if (attempt === this.attempt) this.finish(`Could not start a session: ${errorText(error)}`);
      });
  }

  /** Ends the session, if any, and says so on the page. */
  disconnect(message = "Disconnected."): void {
    if (this.live) this.finish(message);
  }

  /** Hands the sign-in to noVNC. Nothing here keeps it. */
  sendCredentials(values: Partial<Record<CredentialType, string>>): void {
    if (this.snapshot.stage.kind !== "credentials" || this.rfb === null) return;
    this.set({ stage: { kind: "signing-in" } });
    this.rfb.sendCredentials(values);
  }

  setViewOnly(viewOnly: boolean): void {
    if (this.rfb !== null) this.rfb.viewOnly = viewOnly;
    this.set({ viewOnly });
  }

  /** Gives the screen the keyboard, when it is on the page. */
  focus(): void {
    if (this.rfb !== null && this.snapshot.stage.kind === "connected" && this.element.isConnected) {
      this.rfb.focus({ preventScroll: true });
    }
  }

  /** Ends any session and forgets the last one: a fresh store, for tests. */
  reset(): void {
    this.disconnect();
    this.set({ stage: { kind: "idle" }, hostId: null, hostName: null, viewOnly: false, ended: null });
  }

  private finish(message: string): void {
    this.attempt++;
    this.stopIdleWatch();
    const rfb = this.rfb;
    const socket = this.socket;
    this.rfb = null;
    this.socket = null;
    this.set({ stage: { kind: "idle" }, ended: message });
    // noVNC's own disconnect event fires from here and is ignored: the attempt has moved on.
    if (rfb !== null) rfb.disconnect();
    else socket?.close();
  }

  private startIdleWatch(): void {
    this.stopIdleWatch();
    this.lastInput = Date.now();
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastInput >= INPUT_IDLE_MS) {
        this.disconnect(`Closed after ${SESSION_LIMITS.idleMinutes} minutes without keyboard or mouse use.`);
      }
    }, INPUT_IDLE_CHECK_MS);
  }

  private stopIdleWatch(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private set(patch: Partial<ScreenSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** This window's session. */
export const screenSession = new ScreenSessionStore();

if (typeof window !== "undefined") {
  // A page put away for good (closed, or into the back/forward cache) takes its session with it.
  window.addEventListener("pagehide", () => screenSession.disconnect());
}
