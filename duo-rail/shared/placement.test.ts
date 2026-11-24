import { describe, expect, it } from "vitest";

import {
  BOTTOM_MARGIN,
  BUTTON_GAP,
  BUTTON_SIZE,
  DEFAULT_CAMERA_CLEARANCE,
  DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
  MIN_TOUCH_TARGET,
  normalizeClearance,
  railPlacement,
  stripSide,
  type PlacementInput,
} from "./placement";

/** The folded Duo's cover screen, as bb's web view sees it (iPhone Duo, iOS 27.1, measured in get-bb/bb#7507). */
const DUO: PlacementInput = {
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  viewportHeight: 678,
  cameraClearance: DEFAULT_CAMERA_CLEARANCE,
  defaultClearance: DEFAULT_CAMERA_CLEARANCE,
  buttonCount: 3,
};

/** The unfolded display, landscape, from the owner's screenshot: 951×669 pt with an 85 pt strip on the right. */
const UNFOLDED: PlacementInput = {
  insets: { top: 0, right: 85, bottom: 21, left: 0 },
  viewportHeight: 669,
  cameraClearance: undefined,
  defaultClearance: DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
  buttonCount: 3,
};

const at = (change: Partial<PlacementInput>): PlacementInput => ({ ...DUO, ...change });

describe("railPlacement", () => {
  it("stands the rail on the bottom of the folded Duo's right strip, clear of the home indicator", () => {
    expect(railPlacement(DUO)).toEqual({ side: "right", width: 84, bottom: 34 + BOTTOM_MARGIN, cameraGap: 175, buttonSize: BUTTON_SIZE, gap: BUTTON_GAP });
  });

  it("keeps the column at the bottom whatever the camera gap, which only limits how high it may reach", () => {
    expect(railPlacement(at({ cameraClearance: 0 }))?.bottom).toBe(34 + BOTTOM_MARGIN);
    expect(railPlacement(at({ cameraClearance: 235 }))?.bottom).toBe(34 + BOTTOM_MARGIN);
  });

  it("follows the bottom inset, and leaves the margin even with none", () => {
    expect(railPlacement(at({ insets: { top: 0, right: 84, bottom: 0, left: 0 } }))?.bottom).toBe(BOTTOM_MARGIN);
    expect(BOTTOM_MARGIN).toBeGreaterThan(0);
  });

  it("mirrors to the left strip on a mirrored device", () => {
    expect(railPlacement(at({ insets: { top: 0, right: 0, bottom: 34, left: 84 } }))).toMatchObject({ side: "left", width: 84 });
  });

  it("shows the rail at the bottom of the unfolded display's strip, whatever layout bb picked, under its own camera gap", () => {
    expect(railPlacement(UNFOLDED)).toEqual({
      side: "right",
      width: 85,
      bottom: 21 + BOTTOM_MARGIN,
      cameraGap: DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
      buttonSize: BUTTON_SIZE,
      gap: BUTTON_GAP,
    });
    expect(railPlacement({ ...UNFOLDED, cameraClearance: 130 })?.cameraGap).toBe(130);
  });

  it.each<[string, Partial<PlacementInput>]>([
    ["no insets (a desktop browser, bb's desktop app, an iPad without a home indicator)", { insets: { top: 0, right: 0, bottom: 0, left: 0 } }],
    ["an iPad with a home indicator (bottom inset only)", { insets: { top: 0, right: 0, bottom: 20, left: 0 } }],
    ["no buttons in the owner's layout", { buttonCount: 0 }],
    ["an iPhone in portrait (top inset, no side strip)", { insets: { top: 62, right: 0, bottom: 34, left: 0 } }],
    ["the Duo with its status bar moved to the top", { insets: { top: 82, right: 0, bottom: 34, left: 0 } }],
    ["a top inset beside the strip", { insets: { top: 20, right: 84, bottom: 34, left: 0 } }],
    ["an iPhone in landscape (a strip on both sides)", { insets: { top: 0, right: 59, bottom: 21, left: 59 } }],
    ["a strip too narrow for a 44 pt button", { insets: { top: 0, right: 30, bottom: 34, left: 0 } }],
  ])("draws nothing on %s", (_, change) => {
    expect(railPlacement(at(change))).toBeNull();
  });

  it("falls back to the display's default gap when the setting is missing or broken", () => {
    expect(railPlacement(at({ cameraClearance: undefined, defaultClearance: 140 }))?.cameraGap).toBe(140);
    expect(railPlacement(at({ cameraClearance: "x", defaultClearance: 140 }))?.cameraGap).toBe(140);
  });

  it("draws nothing when the column would reach above the camera gap", () => {
    // 3 buttons of 48 with two 6 pt gaps is 156 pt, standing 34 + 8 pt up: its top is 678 − 42 − 156 = 480.
    expect(railPlacement(at({ cameraClearance: 480 }))).not.toBeNull();
    expect(railPlacement(at({ cameraClearance: 481 }))).toBeNull();
    // Eight buttons (426 pt) under the owner's 235 pt gap: 678 − 42 − 426 = 210, too high.
    expect(railPlacement(at({ cameraClearance: 235, buttonCount: 8 }))).toBeNull();
    expect(railPlacement(at({ cameraClearance: 210, buttonCount: 8 }))).not.toBeNull();
    // The keyboard shrinks the page: no clipped rail.
    expect(railPlacement(at({ viewportHeight: 300 }))).toBeNull();
  });

  it("keeps the column tight, with every button still at least the 44 pt touch target", () => {
    const placement = railPlacement(DUO);
    expect(placement?.gap).toBeLessThan(12);
    expect(placement?.buttonSize).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  it("never makes a button wider than the strip", () => {
    expect(railPlacement(at({ insets: { top: 0, right: 46, bottom: 34, left: 0 } }))?.buttonSize).toBe(46);
  });
});

describe("stripSide", () => {
  it("treats sub-point insets as zero", () => {
    expect(stripSide({ top: 0.2, right: 84, bottom: 34, left: 0.3 })).toBe("right");
  });
});

describe("normalizeClearance", () => {
  it.each<[unknown, number]>([
    [175, 175],
    [undefined, DEFAULT_CAMERA_CLEARANCE],
    ["200", DEFAULT_CAMERA_CLEARANCE],
    [Number.NaN, DEFAULT_CAMERA_CLEARANCE],
    [-5, 0],
    [10_000, 600],
    [180.6, 181],
  ])("%s → %s", (value, expected) => {
    expect(normalizeClearance(value)).toBe(expected);
  });

  it("uses the fallback it is given", () => {
    expect(normalizeClearance(undefined, DEFAULT_UNFOLDED_CAMERA_CLEARANCE)).toBe(DEFAULT_UNFOLDED_CAMERA_CLEARANCE);
  });
});
