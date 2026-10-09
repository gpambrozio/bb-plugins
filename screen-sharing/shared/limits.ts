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

/** The server calls a quiet remote session's host at least this often… */
export const HOST_KEEPALIVE_MS = 60_000;
/** …and the host ends a session the server has not called about for this long. */
export const HOST_SILENCE_MS = 3 * HOST_KEEPALIVE_MS;
