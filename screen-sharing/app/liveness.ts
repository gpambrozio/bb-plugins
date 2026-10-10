/**
 * The page's check that the relay is still there. A WebSocket can stay open
 * in the browser after the server behind it has gone — bb restarting behind
 * the getbb.app tunnel leaves the browser's end open — so a close event alone
 * cannot tell the page its session is over. This pings the relay every
 * `PING_EVERY_MS` and calls `onLost` once a ping has gone unanswered, with
 * nothing else from the relay either, for `LOST_AFTER_MS`
 * (shared/channels.ts). Any frame counts as an answer: a busy screen's bytes
 * may arrive ahead of the pong.
 *
 * It listens beside noVNC on the same socket, as flow.ts does; the relay's
 * pongs never reach noVNC (relay-channel.ts).
 */
import { LOST_AFTER_MS, PING_EVERY_MS, PING_FRAME } from "../shared/channels";

/** WebSocket.OPEN, which the test doubles do not define. */
const OPEN = 1;

/** Starts watching `socket`; the returned function stops. */
export function watchRelay(socket: WebSocket, onLost: () => void): () => void {
  /** When the unanswered ping went out, or null when nothing is waiting for an answer. */
  let pingSentAt: number | null = null;
  let lastTick = Date.now();

  function onMessage(): void {
    pingSentAt = null;
  }

  function tick(): void {
    const now = Date.now();
    // A browser holds back the timers of a hidden tab or a sleeping laptop: a ping that waited
    // that long says nothing about the relay, so it is sent again and timed afresh.
    const late = now - lastTick > 2 * PING_EVERY_MS;
    lastTick = now;
    if (socket.readyState !== OPEN) return;
    if (pingSentAt !== null && !late) {
      if (now - pingSentAt < LOST_AFTER_MS) return;
      stop();
      onLost();
      return;
    }
    pingSentAt = now;
    try {
      socket.send(PING_FRAME);
    } catch {
      // Closing under us: its close event ends the session.
    }
  }

  const timer = setInterval(tick, PING_EVERY_MS);
  socket.addEventListener("message", onMessage);

  function stop(): void {
    clearInterval(timer);
    socket.removeEventListener("message", onMessage);
  }
  return stop;
}
