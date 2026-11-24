// Where the rail goes, if anywhere. Pure, so the show/hide rule is tested without a browser.
//
// The iPhone Duo keeps a system strip down one side of both its displays: 84 pt on the folded cover
// screen (466×678 pt) and about 85 pt on the unfolded one (about 951×669 pt, landscape). The camera,
// the clock and the status icons take the strip's top; the rest is blank. A page sees the strip as a
// large `env(safe-area-inset-right)` (or left, on a mirrored device) with a top inset of 0, a
// signature no other device has:
//
// - an ordinary iPhone in portrait has a top inset (the notch or Dynamic Island) and no side inset;
// - an ordinary iPhone in landscape has a side inset on both sides;
// - an iPad, a desktop browser and bb's desktop app have no side inset at all.
//
// So the rule is the strip's own signature, whatever layout bb picked. bb pads its page by the same
// insets, so the strip is outside bb's UI on either layout and the rail covers nothing of bb's.
//
// The column stands on the bottom of the strip, just above the home indicator, and stacks upward. The
// island at the top grows and shrinks (a Live Activity runs well down the strip, the clock alone does
// not) and the page cannot see it: no inset or size changes with it. So the buttons stay as far from it
// as they can, and the camera gap setting is only their upper limit.

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
  /** Distance of the last button's bottom edge from the bottom of the page: the column stacks up from there. */
  bottom: number;
  /** The camera gap in use: the column never reaches higher than this, from the top of the page. */
  cameraGap: number;
  /** Width and height of each button. */
  buttonSize: number;
  gap: number;
}

export interface PlacementInput {
  insets: Insets;
  viewportHeight: number;
  /** Space left free at the top of the strip for the camera and status bar, in points: the setting as stored. */
  cameraClearance: unknown;
  /** What a missing or broken `cameraClearance` means: the display's default. */
  defaultClearance: number;
  /** How many buttons the rail shows. */
  buttonCount: number;
}

/** Apple's minimum touch target. A strip narrower than this cannot hold a button. */
export const MIN_TOUCH_TARGET = 44;
export const BUTTON_SIZE = 48;
/** Between buttons: the 48 pt targets already have room around their 22 pt symbols, so a small gap reads as one column. */
export const BUTTON_GAP = 6;
/** The folded cover screen's camera and vertical status bar end about 170 pt down. */
export const DEFAULT_CAMERA_CLEARANCE = 175;
/** On the unfolded display the clock and the status icons end about 100 pt down. */
export const DEFAULT_UNFOLDED_CAMERA_CLEARANCE = 110;
export const MAX_CAMERA_CLEARANCE = 600;
/** Clear space between the last button and the bottom inset (the home indicator's band). */
export const BOTTOM_MARGIN = 8;

/** Insets come from computed CSS lengths, so anything under half a point is zero. */
const ZERO = 0.5;

/** The setting as typed, made usable: a missing or broken value is the default, and it stays on screen. */
export function normalizeClearance(value: unknown, fallback = DEFAULT_CAMERA_CLEARANCE): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_CAMERA_CLEARANCE, Math.max(0, Math.round(value)));
}

/** Which side holds the Duo's strip, or null when the insets are not the Duo's. */
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
  if (input.buttonCount < 1) return null;
  const side = stripSide(input.insets);
  if (side === null) return null;
  const width = input.insets[side];
  const buttonSize = Math.min(BUTTON_SIZE, width);
  const cameraGap = normalizeClearance(input.cameraClearance, input.defaultClearance);
  const bottom = input.insets.bottom + BOTTOM_MARGIN;
  const column = input.buttonCount * buttonSize + Math.max(0, input.buttonCount - 1) * BUTTON_GAP;
  // Between the camera gap and the home indicator, or not at all: a cut-off button is worse than none.
  if (input.viewportHeight - bottom - column < cameraGap) return null;
  return { side, width, bottom, cameraGap, buttonSize, gap: BUTTON_GAP };
}
