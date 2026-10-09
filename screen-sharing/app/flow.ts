/**
 * The page's half of flow control: tells the relay how many bytes this page
 * has received, in a text frame at most every `ACK_EVERY_MS`, so the relay
 * reads from the Mac only as fast as the page takes it in (shared/channels.ts).
 * It listens beside noVNC on the same socket and never touches what noVNC
 * reads; noVNC sends only binary frames, so the relay can tell the two apart.
 */
import { ACK_EVERY_MS, ackFrame } from "../shared/channels";

/** WebSocket.OPEN, which the test doubles do not define. */
const OPEN = 1;

function byteLength(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return 0;
}

/** Starts acknowledging what arrives on `socket`; the returned function stops. */
export function acknowledgeReceived(socket: WebSocket, everyMs = ACK_EVERY_MS): () => void {
  let received = 0;
  let acknowledged = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send(): void {
    timer = null;
    if (socket.readyState !== OPEN || received === acknowledged) return;
    acknowledged = received;
    socket.send(ackFrame(received));
  }

  function onMessage(event: MessageEvent): void {
    received += byteLength(event.data);
    timer ??= setTimeout(send, everyMs);
  }

  socket.addEventListener("message", onMessage);
  return () => {
    socket.removeEventListener("message", onMessage);
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
