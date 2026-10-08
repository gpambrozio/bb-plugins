/**
 * Keys the page sends to the Mac on the user's behalf, for shortcuts the
 * computer in front of the user keeps for itself. macOS hands Cmd-Tab,
 * Cmd-Space, Mission Control and the like to the system before any app sees
 * them, and no browser API can claim them on a Mac (Chromium's macOS keyboard
 * hook is a stub), so the only way to give them to the shared Mac is to send
 * them from a menu. See AGENTS.md, "Keys".
 *
 * Keysyms are X11's, as RFB uses them; `code` is the DOM code noVNC pairs with
 * each. Command is `Super_L`, which is what noVNC sends for the Command key.
 */

export interface RemoteKey {
  keysym: number;
  code: string;
}

export const Key = {
  command: { keysym: 0xffeb, code: "MetaLeft" },
  control: { keysym: 0xffe3, code: "ControlLeft" },
  option: { keysym: 0xffe9, code: "AltLeft" },
  tab: { keysym: 0xff09, code: "Tab" },
  space: { keysym: 0x0020, code: "Space" },
  grave: { keysym: 0x0060, code: "Backquote" },
  escape: { keysym: 0xff1b, code: "Escape" },
  q: { keysym: 0x0071, code: "KeyQ" },
  w: { keysym: 0x0077, code: "KeyW" },
  h: { keysym: 0x0068, code: "KeyH" },
  r: { keysym: 0x0072, code: "KeyR" },
  up: { keysym: 0xff52, code: "ArrowUp" },
  down: { keysym: 0xff54, code: "ArrowDown" },
  left: { keysym: 0xff51, code: "ArrowLeft" },
  right: { keysym: 0xff53, code: "ArrowRight" },
} as const satisfies Record<string, RemoteKey>;

export interface KeyCombo {
  id: string;
  /** As macOS writes it, e.g. "⌘Tab". */
  label: string;
  /** What it does on the Mac. */
  description: string;
  /** Pressed in order, released in reverse. */
  keys: readonly RemoteKey[];
}

/** The menu, in order. */
export const KEY_COMBOS: readonly KeyCombo[] = [
  { id: "cmd-tab", label: "⌘Tab", description: "Switch to the last app", keys: [Key.command, Key.tab] },
  { id: "cmd-space", label: "⌘Space", description: "Spotlight", keys: [Key.command, Key.space] },
  { id: "cmd-grave", label: "⌘`", description: "Next window of the app", keys: [Key.command, Key.grave] },
  { id: "mission-control", label: "⌃↑", description: "Mission Control", keys: [Key.control, Key.up] },
  { id: "app-windows", label: "⌃↓", description: "App windows", keys: [Key.control, Key.down] },
  { id: "space-left", label: "⌃←", description: "Space to the left", keys: [Key.control, Key.left] },
  { id: "space-right", label: "⌃→", description: "Space to the right", keys: [Key.control, Key.right] },
  { id: "cmd-w", label: "⌘W", description: "Close the window", keys: [Key.command, Key.w] },
  { id: "cmd-h", label: "⌘H", description: "Hide the app", keys: [Key.command, Key.h] },
  { id: "cmd-q", label: "⌘Q", description: "Quit the app", keys: [Key.command, Key.q] },
  { id: "cmd-r", label: "⌘R", description: "Reload (bb's desktop app keeps ⌘R)", keys: [Key.command, Key.r] },
  { id: "force-quit", label: "⌥⌘Esc", description: "Force Quit", keys: [Key.option, Key.command, Key.escape] },
  { id: "escape", label: "Esc", description: "Escape, while full screen takes it", keys: [Key.escape] },
];
