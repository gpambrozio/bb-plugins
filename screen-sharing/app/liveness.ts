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
 * The wait is counted in ticks, not by the clock: each tick adds at most one
 * interval, however late it runs. A browser holds back a page's timers — a
 * busy page, a hidden tab, a short sleep — and the pong that arrived meanwhile
 * is handled only after the late tick, so time the page was not running must
 * not count as the relay's silence. The clock jumping either way does not
 * count either.
 *
 * It listens beside noVNC on the same socket, as flow.ts does; the relay's
 * pongs never reach noVNC (relay-channel.ts).
 */
import { LOST_AFTER_MS, PING_EVERY_MS, PING_FRAME } from "../shared/channels";

/** WebSocket.OPEN, which the test doubles do not define. */
const OPEN = 1;

/** Starts watching `socket`; the returned function stops. */
export function watchRelay(socket: WebSocket, onLost: () => void): () => void {
  /** Whether a ping is out with nothing heard since. */
  let waiting = false;
  /** How long it has been out, as the page could watch it: at most one interval per tick. */
  let waited = 0;
  let lastTick = Date.now();

  function onMessage(): void {
    waiting = false;
  }

  function tick(): void {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    if (socket.readyState !== OPEN) return;
    if (waiting) {
      // Late ticks count as one interval; a clock set back counts as one too.
      waited += elapsed < 0 ? PING_EVERY_MS : Math.min(elapsed, PING_EVERY_MS);
      if (waited < LOST_AFTER_MS) return;
      stop();
      onLost();
      return;
    }
    waiting = true;
    waited = 0;
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
