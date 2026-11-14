/**
 * Which bb client the page runs in, the way Herald tells them apart: the desktop shell exposes
 * `window.bbDesktop`, the mobile shell a `window.bb.native` bridge, and a browser tab neither. These are bb
 * internals, not SDK: if they change, everything reads as "browser", which only keeps the screen awake
 * where it need not.
 */
export type VoicePlatform = "desktop" | "mobile" | "browser";

export function voicePlatform(): VoicePlatform {
  if (typeof window === "undefined") return "browser";
  if ("bbDesktop" in window) return "desktop";
  const bridge = (window as unknown as { bb?: { native?: unknown } }).bb;
  if (bridge?.native !== undefined) return "mobile";
  return "browser";
}
