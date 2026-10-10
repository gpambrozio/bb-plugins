/**
 * Numbers the server and the host entry share. No SDK import: the host bundle
 * and the server bundle both include it.
 */

/** macOS Screen Sharing, on every Mac's own loopback. */
export const SCREEN_SHARING_PORT = 5900;

/**
 * Bytes the Mac may send before the viewer acknowledges them, end to end:
 * from Screen Sharing, through the relay, to the page. Beyond it the relay
 * stops reading from Screen Sharing. It bounds what a session can hold in
 * memory on the way, and caps throughput at about window ÷ round trip — over
 * the host link (≈0.6–0.7 s), 16 MiB allows ≈20 MiB/s, more than Screen
 * Sharing sends.
 */
export const LOOPBACK_WINDOW_BYTES = 8 * 1024 * 1024;
export const HOST_WINDOW_BYTES = 16 * 1024 * 1024;

/**
 * Writes to a remote Mac the server keeps in flight, counted from the
 * earliest one not yet answered: input never waits a round trip behind the
 * last batch. bb may deliver them out of order, and the host holds a write
 * that arrives early, up to `MAX_WRITES_AHEAD` past the one it waits for —
 * which must stay above the server's window.
 *
 * A scroll or a drag sends input every frame (≈60 a second), and at a
 * ≈0.6 s round trip that is ≈36 writes a round trip. With 8 in flight, input
 * queued behind the window for up to a round trip more: a scroll over a link
 * 300 ms each way reached the Mac after ≈550 ms (median) instead of 300 ms.
 * 24 brings that to ≈300 ms (`server/remote.test.ts` measures it).
 */
export const MAX_PIPELINED_WRITES = 24;
export const MAX_WRITES_AHEAD = 32;

/**
 * The server calls a quiet remote session's host at least this often, so a
 * Mac that has gone (its bb restarted, its network lost) ends the session in
 * seconds: a call to a host bb is not connected to fails…
 */
export const HOST_KEEPALIVE_MS = 5_000;
/** …and gives up on a keepalive left unanswered for this long… */
export const HOST_KEEPALIVE_TIMEOUT_MS = 10_000;
/** …and the host ends a session the server has not called about for this long. */
export const HOST_SILENCE_MS = 3 * 60_000;
