// Where the rail goes, if anywhere. Pure, so the show/hide rule is tested without a browser.
//
// The folded iPhone Duo's cover screen is 466×678 pt with an 84 pt system strip on one side (the
// right, or the left on a mirrored device). The camera and the vertical status bar take the strip's
// top ~175 pt and the rest is blank. A page sees it as `env(safe-area-inset-right)` 84 (or left),
// top 0 and bottom 34 — a signature no other iPhone layout has:
//
// - an ordinary iPhone in portrait has a top inset (the notch or Dynamic Island) and no side inset;
// - an ordinary iPhone in landscape has a side inset on both sides, and is wider than bb's compact
//   breakpoint anyway;
// - the Duo unfolded, and Split View, have no side strip.

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type RailSide = "left" | "right";

export interface RailPlacement {
  side: RailSide;
  /** The strip's width: the rail draws inside it and nowhere else. */
  width: number;
  /** Distance of the first button from the top of the page. */
  top: number;
  /** Width and height of each button. */
  buttonSize: number;
  gap: number;
}

export interface PlacementInput {
  /** bb's compact (phone) layout, `(max-width: 767px)`. */
  compact: boolean;
  insets: Insets;
  viewportHeight: number;
  /** Space left free at the top of the strip for the camera and status bar, in points: the setting as stored. */
  cameraClearance: unknown;
  /** How many buttons the rail shows. */
  buttonCount: number;
}

/** Apple's minimum touch target. A strip narrower than this cannot hold a button. */
export const MIN_TOUCH_TARGET = 44;
export const BUTTON_SIZE = 48;
export const BUTTON_GAP = 12;
export const DEFAULT_CAMERA_CLEARANCE = 175;
export const MAX_CAMERA_CLEARANCE = 600;

/** Insets come from computed CSS lengths, so anything under half a point is zero. */
const ZERO = 0.5;

/** The setting as typed, made usable: a missing or broken value is the default, and it stays on screen. */
export function normalizeClearance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CAMERA_CLEARANCE;
  return Math.min(MAX_CAMERA_CLEARANCE, Math.max(0, Math.round(value)));
}

/** Which side holds the Duo's strip, or null when the insets are not the folded Duo's. */
export function stripSide(insets: Insets): RailSide | null {
  if (insets.top >= ZERO) return null;
  const right = insets.right >= MIN_TOUCH_TARGET && insets.left < ZERO;
  const left = insets.left >= MIN_TOUCH_TARGET && insets.right < ZERO;
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** The rail's place, or null to draw nothing. */
export function railPlacement(input: PlacementInput): RailPlacement | null {
  if (!input.compact) return null;
  const side = stripSide(input.insets);
  if (side === null) return null;
  const width = input.insets[side];
  const buttonSize = Math.min(BUTTON_SIZE, width);
  const top = normalizeClearance(input.cameraClearance);
  const column = input.buttonCount * buttonSize + Math.max(0, input.buttonCount - 1) * BUTTON_GAP;
  // Below the camera and above the home indicator, or not at all: a cut-off button is worse than none.
  if (top + column > input.viewportHeight - input.insets.bottom) return null;
  return { side, width, top, buttonSize, gap: BUTTON_GAP };
}
