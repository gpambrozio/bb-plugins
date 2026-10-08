/**
 * The pointer over the remote screen. Shared by the session store, which puts
 * the rule on the page, and rfb.ts, which marks when the server sends a cursor.
 */

/** Set on the screen element once the server has sent any cursor shape. */
export const REMOTE_CURSOR_ATTRIBUTE = "data-remote-cursor";

/**
 * noVNC sets its canvas's CSS cursor to `none` until the server sends a
 * cursor shape, and macOS Screen Sharing sends none noVNC can draw, so the
 * pointer vanished over the screen. Until a shape arrives, show the ordinary
 * arrow, which is exactly where a click lands. Once the server has sent any
 * shape (`REMOTE_CURSOR_ATTRIBUTE`, set by rfb.ts), the rule stands aside:
 * the remote cursor is shown as sent, an empty one included — that is how a
 * server hides its pointer. noVNC's `showDotCursor` stays off: it would
 * replace the empty start-up cursor with a 3-pixel dot and keep this rule
 * from ever matching.
 */
export const LOCAL_CURSOR_CSS = `[data-screen-sharing-screen]:not([${REMOTE_CURSOR_ATTRIBUTE}]) canvas[style*="cursor: none"] { cursor: default !important; }`;
