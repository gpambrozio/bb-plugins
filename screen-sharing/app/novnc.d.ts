/**
 * The part of noVNC's `RFB` (core/rfb.js, @novnc/novnc 1.7) this plugin uses.
 * noVNC ships no types, and DefinitelyTyped's describe the old `lib/rfb` path.
 */
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    wsProtocols?: string[];
  }

  export interface RfbEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<{ types: Array<"username" | "password" | "target"> }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    desktopname: CustomEvent<{ name: string }>;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
    /** Sends a key to the server; does nothing unless connected and not view-only. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    addEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
    removeEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
  }
}
