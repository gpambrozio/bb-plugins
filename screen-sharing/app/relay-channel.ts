/**
 * The relay's WebSocket as noVNC sees it. noVNC takes any object shaped like
 * a WebSocket (a "raw channel"); this one stands between the two to:
 *
 * - keep the relay's text frames (`pong`, liveness.ts) from noVNC, which
 *   reads every frame as RFB bytes (a `pong` happens to come out empty);
 * - send a burst of noVNC's messages as one frame, when asked (`gather`).
 *   noVNC sends each message as its own frame — a scroll step is two pointer
 *   events — and over bb's host link every frame the relay gets becomes a
 *   call to the Mac, with a bounded number in flight (shared/limits.ts). One
 *   wheel event's steps go as one frame, so a scroll costs one call per event.
 *
 * The page's own listeners (flow.ts, liveness.ts, the close code) stay on the
 * real socket.
 */

/** WebSocket.OPEN, which the test doubles do not define. */
const OPEN = 1;

type Handler<E extends Event> = ((event: E) => void) | null;

export class RelayChannel {
  // Own properties: noVNC checks that a raw channel has each of these before it takes it.
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  onclose: Handler<CloseEvent> = null;
  /** What noVNC sent inside `gather`, while it runs; null otherwise. */
  private gathered: Uint8Array[] | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("open", (event) => this.onopen?.(event));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") this.onmessage?.(event);
    });
    socket.addEventListener("error", (event) => this.onerror?.(event));
    socket.addEventListener("close", (event) => this.onclose?.(event));
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(value: BinaryType) {
    this.socket.binaryType = value;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.gathered === null) {
      this.socket.send(data);
      return;
    }
    // A copy: noVNC reuses its send buffer once `send` returns.
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.gathered.push(view.slice());
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  /** Runs `sendMessages` and sends everything it sent through this channel as one frame. */
  gather(sendMessages: () => void): void {
    if (this.gathered !== null) {
      sendMessages();
      return;
    }
    const parts: Uint8Array[] = [];
    this.gathered = parts;
    try {
      sendMessages();
    } finally {
      this.gathered = null;
    }
    if (parts.length === 0 || this.socket.readyState !== OPEN) return;
    const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    this.socket.send(joined);
  }
}
