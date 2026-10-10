/**
 * The relay: one WebSocket from noVNC in the app, one link to the chosen
 * Mac's Screen Sharing (link.ts) — a TCP connection on the server's own
 * loopback, or bb's host link to another Mac. Bytes are copied both ways and
 * never read. It reads only the ticket in the URL and the page's ack frames;
 * the VNC sign-in (macOS user name and password) travels inside the RFB
 * stream, encrypted by Apple's ARD handshake, and is never seen here.
 *
 * A WebSocket opens a session only with a ticket the registry minted for that
 * Mac (sessions.ts). Either side closing closes the other, and the registry
 * can close both (idle, maximum length, Close all, plugin stopping).
 *
 * Flow control: the page acknowledges what it has received (`ack:<bytes>`
 * text frames, shared/channels.ts); the link stops reading from the Mac while
 * too much is unacknowledged. Liveness: the page also pings (`ping`), and the
 * relay answers each with `pong` at once, so a page whose socket outlived the
 * server can tell.
 */
import type { ExperimentalPluginWebSocket, ExperimentalPluginWebSocketHandler } from "@get-bb/plugin-sdk";

import { CloseCode, FLOW_PARAM, FLOW_VERSION, PING_FRAME, PONG_FRAME, parseAck } from "../shared/channels";
import type { Link, OpenLink } from "./link";
import type { OpenSession, SessionRegistry } from "./sessions";

export interface RelayOptions {
  registry: SessionRegistry;
  openLink: OpenLink;
  log(message: string): void;
}

/** A close reason is at most 123 bytes of UTF-8 on the wire; `ws` throws on a longer one. */
const MAX_REASON_BYTES = 123;
const encoder = new TextEncoder();

/**
 * The reason cut to fit, by bytes and at a whole character: a Mac's name in
 * the reason may be Chinese or emoji, three or four bytes a character.
 */
export function shortReason(reason: string): string {
  if (encoder.encode(reason).length <= MAX_REASON_BYTES) return reason;
  const ellipsis = "…";
  let budget = MAX_REASON_BYTES - encoder.encode(ellipsis).length;
  let cut = "";
  for (const character of reason) {
    budget -= encoder.encode(character).length;
    if (budget < 0) break;
    cut += character;
  }
  return `${cut}${ellipsis}`;
}

function closeQuietly(ws: ExperimentalPluginWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, shortReason(reason));
  } catch {
    // Already closed: nothing left to tell the app.
  }
}

export function createRelay(options: RelayOptions): ExperimentalPluginWebSocketHandler {
  const { registry } = options;

  return (context) => {
    const hostId = context.url.searchParams.get("host") ?? "";
    const token = context.url.searchParams.get("token") ?? "";
    const flow = context.url.searchParams.get(FLOW_PARAM);
    let ws: ExperimentalPluginWebSocket | null = null;
    let link: Link | null = null;
    let session: OpenSession | null = null;
    let done = false;
    /** Bytes sent to the page, and the most it has acknowledged. */
    let sent = 0;
    let acked = 0;

    /** Drops both ends once; `tell` is what the app hears, when it is still there to hear it. */
    function finish(tell?: { code: number; reason: string }): void {
      if (done) return;
      done = true;
      link?.close();
      session?.closed();
      if (tell !== undefined && ws !== null) closeQuietly(ws, tell.code, tell.reason);
      if (session !== null) options.log(`session ${session.id} closed${tell === undefined ? "" : `: ${tell.reason}`}`);
    }

    /** Tells the page the relay is still here (shared/channels.ts: liveness). */
    function pong(): void {
      try {
        ws?.send(PONG_FRAME);
      } catch (error) {
        finish({ code: CloseCode.failed, reason: `could not send to the page (${error instanceof Error ? error.message : String(error)})` });
      }
    }

    function onAck(frame: string): void {
      const total = parseAck(frame);
      if (total === null) {
        finish({ code: CloseCode.policy, reason: "text frames other than acks are not part of VNC" });
        return;
      }
      if (total < acked || total > sent) {
        finish({ code: CloseCode.policy, reason: "the page acknowledged bytes it was never sent" });
        return;
      }
      acked = total;
      link?.ack(total);
    }

    return {
      onOpen(opened) {
        ws = opened;
        // Checked before the ticket, which stays unused: a page from before flow control would stall.
        if (flow !== FLOW_VERSION) {
          done = true;
          options.log("refused a connection from a page without flow control");
          closeQuietly(opened, CloseCode.policy, "this page is out of date; reload bb and connect again");
          return;
        }
        const redeemed = registry.redeem(token, hostId);
        if (!redeemed.ok) {
          done = true;
          options.log(`refused a connection: ${redeemed.reason}`);
          closeQuietly(opened, CloseCode.policy, redeemed.reason);
          return;
        }
        const open = registry.open(hostId, (code, reason) => finish({ code, reason }));
        session = open;
        options.log(`session ${open.id} opened (${redeemed.target.route})`);
        const opening = options.openLink(
          { ...redeemed.target, sessionId: open.id },
          {
            data: (bytes) => {
              if (done) return;
              open.touch();
              sent += bytes.length;
              try {
                opened.send(bytes);
              } catch (error) {
                // Called from socket and signal callbacks in the bb server's process: never let it escape.
                finish({ code: CloseCode.failed, reason: `could not send to the page (${error instanceof Error ? error.message : String(error)})` });
              }
            },
            end: (code, reason) => finish({ code, reason }),
          },
        );
        // A link that failed while opening has already finished the session.
        if (done) opening.close();
        else link = opening;
      },

      onMessage(_ws, data) {
        if (done || link === null || session === null) return;
        session.touch();
        if (data === PING_FRAME) pong();
        else if (typeof data === "string") onAck(data);
        else link.write(data);
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
