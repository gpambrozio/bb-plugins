/**
 * The sessions of this bb window, one per Mac, kept outside React so they
 * outlive the page.
 *
 * bb unmounts the Screen Sharing page whenever the user opens something else,
 * but keeps this module loaded for the life of the window. The session — the
 * relay's WebSocket, noVNC's client and the element noVNC draws into — lives
 * here; the page only lends that element a place on screen while it is open
 * (`ScreenMount` in vnc-session.tsx). Coming back reattaches the same live
 * connection: nothing is signed in again, and nothing about the sign-in is
 * kept to make that possible. Sessions to different Macs run side by side;
 * the page shows the one whose Mac is picked, and the others keep running
 * detached, input suspended, as a session does while the page is closed.
 *
 * The session still ends on Disconnect, on Close all and the server's own
 * limits (the relay closes the socket), when the plugin reloads (bb closes the
 * socket), when the relay stops answering pings with its socket left open (bb
 * restarting behind the getbb.app tunnel; liveness.ts), when the window goes
 * away, and after `SESSION_LIMITS.idleMinutes` without a key, click, touch,
 * wheel or pointer movement on the screen — which a detached, unseen screen
 * never gets.
 */
import { SESSION_LIMITS } from "../shared/channels";
import { LOST_MESSAGE, endMessage, type SessionEnd } from "./end-message";
import { LOCAL_CURSOR_CSS } from "./cursor";
import { Key, type KeyCombo } from "./keys";
import { acknowledgeReceived } from "./flow";
import { watchRelay } from "./liveness";
import { createRfb, openRelaySocket, releaseRemoteButtons, type Rfb } from "./rfb";
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
  /** "Full screen" is on: the page in full screen, with the keyboard locked to it. */
  fullScreen: boolean;
  /** ⌘ is held down on the Mac from the Send keys menu, for stepping the app switcher. */
  commandHeld: boolean;
}

/** The Keyboard Lock API, where the browser has it (Chromium only). */
type KeyboardLockNavigator = Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } };

/**
 * Whether "Full screen" can do anything here: Keyboard Lock (Chromium —
 * Chrome, Edge, bb's Electron desktop app) plus the Fullscreen API it needs.
 * Safari and Firefox have no Keyboard Lock.
 */
export function canGoFullScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as KeyboardLockNavigator).keyboard?.lock === "function" &&
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

/** Asks the server for a ticket; the page passes its RPC client's `openSession`. */
export type OpenSession = (hostId: string) => Promise<{ token: string }>;

const INPUT_IDLE_MS = SESSION_LIMITS.idleMinutes * 60_000;
const INPUT_IDLE_CHECK_MS = 30_000;
/** Input on the screen that counts as someone using it. */
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/** noVNC's emulated pointer capture marks the captured element here. */
type CaptureDocument = Document & { captureElement?: Element | null; releaseCapture?: () => void };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ScreenSessionStore {
  private snapshot: ScreenSessionSnapshot = {
    stage: { kind: "idle" },
    hostId: null,
    hostName: null,
    viewOnly: false,
    ended: null,
    fullScreen: false,
    commandHeld: false,
  };
  /** The element put in full screen by "Full screen". */
  private fullscreenTarget: HTMLElement | null = null;
  private readonly listeners = new Set<() => void>();
  /** Bumped by every start and end, so late answers from an older attempt are dropped. */
  private attempt = 0;
  private socket: WebSocket | null = null;
  /** Stops acknowledging what the relay sends (flow.ts). */
  private stopAcks: (() => void) | null = null;
  /** Stops pinging the relay (liveness.ts). */
  private stopWatch: (() => void) | null = null;
  private rfb: Rfb | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastInput = 0;
  private screenElement: HTMLDivElement | null = null;
  /** Whether the page has the screen on show; input is suspended while it does not. */
  private attached = false;
  /** Keys held down over the screen, by `code`, with their `key`. */
  private readonly heldKeys = new Map<string, string>();
  /** Mouse buttons noVNC last saw held over the screen, and where. */
  private heldMouse: { buttons: number; clientX: number; clientY: number } = { buttons: 0, clientX: 0, clientY: 0 };
  /** noVNC's canvas for the current connection; kept because noVNC removes it from the page on disconnect. */
  private canvas: HTMLCanvasElement | null = null;
  /**
   * The object handed to noVNC's `sendCredentials`. noVNC keeps that very
   * object (`_rfbCredentials`) for the life of the connection, so its fields
   * are deleted as soon as the sign-in is over: see `forgetCredentials`.
   */
  private handedCredentials: Partial<Record<CredentialType, string>> | null = null;

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
      const noteMouse = (event: MouseEvent) => {
        this.heldMouse = { buttons: event.buttons, clientX: event.clientX, clientY: event.clientY };
      };
      for (const type of ["mousedown", "mouseup", "mousemove"] as const) {
        element.addEventListener(type, noteMouse, { capture: true, passive: true });
      }
      element.addEventListener("keydown", (event) => this.heldKeys.set(event.code, event.key), { capture: true, passive: true });
      element.addEventListener("keyup", (event) => this.heldKeys.delete(event.code), { capture: true, passive: true });
      this.screenElement = element;
    }
    return this.screenElement;
  }

  get live(): boolean {
    return this.snapshot.stage.kind !== "idle";
  }

  /** Puts the screen on the page and gives input back to it. */
  attach(container: HTMLElement): void {
    container.append(this.element);
    this.attached = true;
    this.applyViewOnly();
    this.focus();
  }

  /**
   * Takes the screen off the page. A key or button held over the screen would
   * otherwise stay down on the Mac — its release lands on whatever page the
   * user went to — so everything held is released first, through noVNC's own
   * handlers: a key-up for each key, and a button-up where the pointer last
   * was. Only then is input suspended. (Suspending alone does not do it:
   * noVNC's view-only setter ungrabs the keyboard after it has turned view
   * only on, and its key-ups are then dropped as view-only input.)
   */
  detach(): void {
    this.stopFullScreen();
    this.releaseHeldInput();
    this.attached = false;
    this.applyViewOnly();
    this.element.remove();
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
        this.stopAcks = acknowledgeReceived(socket);
        // A socket can outlive the server behind it, and then no close event ever comes.
        this.stopWatch = watchRelay(socket, () => {
          if (attempt === this.attempt) this.finish(LOST_MESSAGE);
        });
        // Registered before noVNC's own handler, so it has run when noVNC reports the disconnect.
        socket.addEventListener("close", (event) => {
          end.close = { code: event.code, reason: event.reason };
        });
        const rfb = createRfb(this.element, socket);
        this.rfb = rfb;
        this.canvas = this.element.querySelector("canvas");
        this.applyViewOnly();
        rfb.addEventListener("credentialsrequired", (event) => {
          if (attempt === this.attempt) this.set({ stage: { kind: "credentials", types: event.detail.types } });
        });
        rfb.addEventListener("securityfailure", (event) => {
          end.securityFailure = event.detail.reason ?? `macOS refused the sign-in (status ${event.detail.status})`;
          this.forgetCredentials();
        });
        rfb.addEventListener("connect", () => {
          end.connected = true;
          // Signed in: the encrypted sign-in has been sent, so noVNC no longer needs the plaintext.
          this.forgetCredentials();
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

  /**
   * Hands the sign-in to noVNC, which keeps the object it is given until the
   * sign-in is over; then `forgetCredentials` empties it. noVNC needs the
   * fields until its ARD step has sent the encrypted payload (it re-reads them
   * when it resumes), so they cannot be cleared any earlier.
   */
  sendCredentials(values: Partial<Record<CredentialType, string>>): void {
    if (this.snapshot.stage.kind !== "credentials" || this.rfb === null) return;
    this.set({ stage: { kind: "signing-in" } });
    this.forgetCredentials();
    const handed = { ...values };
    this.handedCredentials = handed;
    this.rfb.sendCredentials(handed);
  }

  /**
   * Turning View only on first releases whatever is held over the screen, as
   * leaving the page does: noVNC drops the key-ups its own view-only switch
   * generates.
   */
  setViewOnly(viewOnly: boolean): void {
    if (viewOnly && !this.snapshot.viewOnly) {
      this.stopFullScreen();
      this.releaseHeldInput();
    }
    this.set({ viewOnly });
    this.applyViewOnly();
  }

  /** Whether the Mac takes keys from this page right now. */
  private get takesKeys(): boolean {
    return this.rfb !== null && this.snapshot.stage.kind === "connected" && !this.snapshot.viewOnly && this.attached;
  }

  /** Presses a combination on the Mac — in order, released in reverse — from the Send keys menu. */
  sendKeys(combo: KeyCombo): void {
    const rfb = this.rfb;
    if (rfb === null || !this.takesKeys) return;
    for (const key of combo.keys) rfb.sendKey(key.keysym, key.code, true);
    for (const key of [...combo.keys].reverse()) rfb.sendKey(key.keysym, key.code, false);
    this.lastInput = Date.now();
    this.focus();
  }

  /**
   * Holds ⌘ down on the Mac and taps Tab, opening the app switcher; Tab on
   * the user's own keyboard then steps it, as with a held ⌘ at the Mac, and
   * `releaseCommand` picks the app. The hold ends with every other release.
   */
  holdCommandForAppSwitcher(): void {
    const rfb = this.rfb;
    if (rfb === null || !this.takesKeys || this.snapshot.commandHeld) return;
    rfb.sendKey(Key.command.keysym, Key.command.code, true);
    rfb.sendKey(Key.tab.keysym, Key.tab.code, true);
    rfb.sendKey(Key.tab.keysym, Key.tab.code, false);
    this.set({ commandHeld: true });
    this.lastInput = Date.now();
    this.focus();
  }

  /** Lets go of the ⌘ held for the app switcher, which picks the app on the Mac. */
  releaseCommand(): void {
    this.letGoOfCommand();
    this.focus();
  }

  private letGoOfCommand(): void {
    if (!this.snapshot.commandHeld) return;
    this.rfb?.sendKey(Key.command.keysym, Key.command.code, false);
    this.set({ commandHeld: false });
  }

  /**
   * "Full screen": puts `target` (the page) in full screen and locks the
   * keyboard to it, the strongest capture a page gets. On a Mac that passes
   * the shortcuts the browser or app would otherwise keep (⌘W, ⌘Q, ⌘T, Esc in
   * Chrome; Esc in bb's desktop app) — never the ones macOS keeps (⌘Tab,
   * ⌘Space, Mission Control): Chromium has no system keyboard hook on macOS.
   * It ends when full screen ends (holding Esc, in Chromium), and with every
   * other way input ends.
   */
  async setFullScreen(on: boolean, target?: HTMLElement): Promise<void> {
    if (!on) {
      this.stopFullScreen();
      return;
    }
    if (this.snapshot.fullScreen || target === undefined || !this.takesKeys || !canGoFullScreen()) return;
    this.fullscreenTarget = target;
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    try {
      await target.requestFullscreen();
      await (navigator as KeyboardLockNavigator).keyboard?.lock?.();
      if (this.fullscreenTarget !== target || !this.takesKeys) {
        this.stopFullScreen();
        return;
      }
      this.set({ fullScreen: true });
      this.focus();
    } catch (error) {
      console.warn("[screen-sharing] could not go full screen", error);
      this.stopFullScreen();
    }
  }

  private readonly onFullscreenChange = (): void => {
    if (this.fullscreenTarget !== null && document.fullscreenElement !== this.fullscreenTarget) this.stopFullScreen();
  };

  private stopFullScreen(): void {
    const target = this.fullscreenTarget;
    if (target === null && !this.snapshot.fullScreen) return;
    this.fullscreenTarget = null;
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    (navigator as KeyboardLockNavigator).keyboard?.unlock?.();
    if (target !== null && document.fullscreenElement === target) {
      document.exitFullscreen().catch(() => {
        // Already leaving full screen.
      });
    }
    if (this.snapshot.fullScreen) this.set({ fullScreen: false });
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
    this.set({ stage: { kind: "idle" }, hostId: null, hostName: null, viewOnly: false, ended: null, fullScreen: false, commandHeld: false });
  }

  private finish(message: string): void {
    this.attempt++;
    this.stopIdleWatch();
    this.stopFullScreen();
    // Before noVNC lets go of its canvas: a button held as the session ends would leave noVNC's
    // pointer capture — a full-window overlay — over bb.
    this.releaseHeldInput();
    const rfb = this.rfb;
    const socket = this.socket;
    this.stopAcks?.();
    this.stopAcks = null;
    this.stopWatch?.();
    this.stopWatch = null;
    this.rfb = null;
    this.socket = null;
    this.canvas = null;
    this.set({ stage: { kind: "idle" }, ended: message });
    // noVNC's own disconnect event fires from here and is ignored: the attempt has moved on.
    if (rfb !== null) rfb.disconnect();
    else socket?.close();
    this.forgetCredentials();
  }

  /** Empties the object noVNC was handed, which noVNC still holds. */
  private forgetCredentials(): void {
    const handed = this.handedCredentials;
    this.handedCredentials = null;
    if (handed === null) return;
    for (const key of Object.keys(handed)) delete handed[key as CredentialType];
  }

  /** View only as the user chose it, and always while the screen is off the page. */
  private applyViewOnly(): void {
    if (this.rfb !== null) this.rfb.viewOnly = this.snapshot.viewOnly || !this.attached;
  }

  /** Releases every key and mouse button held over the screen, through noVNC's own handlers. */
  private releaseHeldInput(): void {
    this.letGoOfCommand();
    this.releaseHeldKeys();
    this.releaseHeldMouse();
    // Whatever noVNC still has pressed, touch gestures included: they press buttons without mouse events.
    if (this.rfb !== null) releaseRemoteButtons(this.rfb);
  }

  private releaseHeldKeys(): void {
    for (const [code, key] of [...this.heldKeys]) {
      this.canvas?.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true, cancelable: true }));
    }
    this.heldKeys.clear();
  }

  /**
   * A button-up for buttons held over the screen, and the end of noVNC's
   * pointer capture. A button-down makes noVNC capture the pointer: where the
   * browser has no `setCapture`, it lays a full-window overlay over the page
   * and listens on `window`, and lets go only when a `mouseup` reaches that
   * `window` listener. So with that capture in place the button-up goes to
   * `window`, where noVNC forwards it to the canvas (sending the release to
   * the Mac) and then removes the overlay; dispatched on the canvas, it would
   * do the first and never the second.
   */
  private releaseHeldMouse(): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    const held = this.heldMouse;
    const captureDocument = document as CaptureDocument;
    const captured = captureDocument.captureElement === canvas;
    if (held.buttons === 0 && !captured) return;
    // noVNC reads the buttons still down from `buttons`: none, at the last pointer position.
    const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, buttons: 0, clientX: held.clientX, clientY: held.clientY });
    if (captured && typeof captureDocument.releaseCapture !== "function") {
      window.dispatchEvent(up);
    } else {
      canvas.dispatchEvent(up);
      if (captured) captureDocument.releaseCapture?.();
    }
    this.heldMouse = { ...held, buttons: 0 };
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

/**
 * This window's sessions, one store per Mac, made when first asked for. Each
 * store is a whole session as described above; nothing is shared between
 * them but the window.
 */
export class ScreenSessions {
  private readonly stores = new Map<string, ScreenSessionStore>();
  private readonly listeners = new Set<() => void>();
  /** Bumped whenever a session starts or ends; a new store is idle, so making one changes nothing. */
  private version = 0;

  for(hostId: string): ScreenSessionStore {
    let store = this.stores.get(hostId);
    if (store === undefined) {
      const made = new ScreenSessionStore();
      let live = false;
      made.subscribe(() => {
        if (made.live === live) return;
        live = made.live;
        this.changed();
      });
      this.stores.set(hostId, made);
      store = made;
    }
    return store;
  }

  /** The Macs with a live session in this window. */
  liveHostIds(): string[] {
    return [...this.stores].filter(([, store]) => store.live).map(([hostId]) => hostId);
  }

  disconnectAll(message?: string): void {
    for (const store of this.stores.values()) store.disconnect(message);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Ends every session and forgets every store: a fresh window, for tests. */
  reset(): void {
    for (const store of this.stores.values()) store.reset();
    this.stores.clear();
    this.changed();
  }

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export const screenSessions = new ScreenSessions();

if (typeof window !== "undefined") {
  // A page put away for good (closed, or into the back/forward cache) takes its sessions with it.
  window.addEventListener("pagehide", () => screenSessions.disconnectAll());
}
