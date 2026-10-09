/**
 * What the relay (relay.ts) talks to on the Mac's side of a session: a TCP
 * connection on the server's own loopback (loopback-link.ts) or bb's host
 * link to another Mac (host-link.ts). The relay owns the WebSocket, the
 * session and the byte counts; a link owns the way to Screen Sharing.
 */
export interface Link {
  /** The viewer's next bytes, in order. */
  write(bytes: Uint8Array): void;
  /** The viewer has received `totalBytes` of this session's data in all; never less than before. */
  ack(totalBytes: number): void;
  /** The relay is ending the session: drop everything and raise no more events. Safe to call twice. */
  close(): void;
}

export interface LinkEvents {
  /** The Mac's next bytes, in order. */
  data(bytes: Uint8Array): void;
  /** The link ended by itself; `code` and `reason` are what the viewer hears. */
  end(code: number, reason: string): void;
}

/** Which way a ticket's session reaches its Mac. */
export type Route = "loopback" | "host";

export interface LinkTarget {
  hostId: string;
  /** For what the viewer is told when the link fails. */
  hostName: string;
  route: Route;
  sessionId: string;
}

export type OpenLink = (target: LinkTarget, events: LinkEvents) => Link;

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
