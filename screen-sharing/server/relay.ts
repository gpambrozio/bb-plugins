/**
 * The relay: one WebSocket from noVNC in the app, one TCP connection to the
 * Mac's Screen Sharing on 127.0.0.1:5900, bytes copied both ways and never
 * read. It reads only the ticket in the URL; the VNC sign-in (macOS user name
 * and password) travels inside the RFB stream, encrypted by Apple's ARD
 * handshake, and is never seen here.
 *
 * A WebSocket opens a session only with a ticket the registry minted for that
 * Mac (sessions.ts). Either side closing closes the other, and the registry
 * can close both (idle, maximum length, Close all, plugin stopping).
 */
import type { Socket } from "node:net";
import type { ExperimentalPluginWebSocket, ExperimentalPluginWebSocketHandler } from "@get-bb/plugin-sdk";

import { CloseCode } from "../shared/channels";
import type { OpenSession, SessionRegistry } from "./sessions";

export interface RelayOptions {
  registry: SessionRegistry;
  /** Opens the TCP connection to Screen Sharing. */
  connect(): Socket;
  /** Bytes the app may send faster than Screen Sharing reads them before the session is ended. */
  maxBufferedBytes: number;
  log(message: string): void;
}

/** A close reason is at most 123 bytes on the wire. */
function shortReason(reason: string): string {
  return reason.length > 100 ? `${reason.slice(0, 99)}…` : reason;
}

function closeQuietly(ws: ExperimentalPluginWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, shortReason(reason));
  } catch {
    // Already closed: nothing left to tell the app.
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

export function createRelay(options: RelayOptions): ExperimentalPluginWebSocketHandler {
  const { registry } = options;

  return (context) => {
    const hostId = context.url.searchParams.get("host") ?? "";
    const token = context.url.searchParams.get("token") ?? "";
    let ws: ExperimentalPluginWebSocket | null = null;
    let socket: Socket | null = null;
    let session: OpenSession | null = null;
    let done = false;

    /** Drops both ends once; `tell` is what the app hears, when it is still there to hear it. */
    function finish(tell?: { code: number; reason: string }): void {
      if (done) return;
      done = true;
      socket?.destroy();
      session?.closed();
      if (tell !== undefined && ws !== null) closeQuietly(ws, tell.code, tell.reason);
      if (session !== null) options.log(`session ${session.id} closed${tell === undefined ? "" : `: ${tell.reason}`}`);
    }

    return {
      onOpen(opened) {
        ws = opened;
        const redeemed = registry.redeem(token, hostId);
        if (!redeemed.ok) {
          done = true;
          options.log(`refused a connection: ${redeemed.reason}`);
          closeQuietly(opened, CloseCode.policy, redeemed.reason);
          return;
        }
        const tcp = options.connect();
        socket = tcp;
        const open = registry.open(hostId, (code, reason) => finish({ code, reason }));
        session = open;
        options.log(`session ${open.id} opened`);

        tcp.on("data", (chunk: Buffer) => {
          if (done) return;
          open.touch();
          opened.send(new Uint8Array(chunk));
        });
        tcp.on("error", (error) => {
          finish({ code: CloseCode.failed, reason: `cannot reach Screen Sharing (${errorCode(error)})` });
        });
        tcp.on("close", () => {
          finish({ code: CloseCode.normal, reason: "Screen Sharing closed the connection" });
        });
      },

      onMessage(_ws, data) {
        if (done || socket === null || session === null) return;
        if (typeof data === "string") {
          finish({ code: CloseCode.policy, reason: "text frames are not part of VNC" });
          return;
        }
        session.touch();
        socket.write(data);
        if (socket.writableLength > options.maxBufferedBytes) {
          finish({ code: CloseCode.failed, reason: "Screen Sharing is not reading" });
        }
      },

      onClose() {
        finish();
      },

      onError(_ws, error) {
        options.log(`relay WebSocket error: ${error.message}`);
        finish();
      },
    };
  };
}
