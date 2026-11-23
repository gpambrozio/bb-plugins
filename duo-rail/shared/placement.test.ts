import { describe, expect, it } from "vitest";

import { BUTTON_GAP, BUTTON_SIZE, DEFAULT_CAMERA_CLEARANCE, normalizeClearance, railPlacement, stripSide, type PlacementInput } from "./placement";

/** The folded Duo's cover screen, as bb's web view sees it (iPhone Duo, iOS 27.1, measured in get-bb/bb#7507). */
const DUO: PlacementInput = {
  compact: true,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  viewportHeight: 678,
  cameraClearance: DEFAULT_CAMERA_CLEARANCE,
  buttonCount: 3,
};

const at = (change: Partial<PlacementInput>): PlacementInput => ({ ...DUO, ...change });

describe("railPlacement", () => {
  it("shows the rail in the right strip of the folded Duo, below the camera", () => {
    expect(railPlacement(DUO)).toEqual({ side: "right", width: 84, top: 175, buttonSize: BUTTON_SIZE, gap: BUTTON_GAP });
  });

  it("mirrors to the left strip on a mirrored device", () => {
    expect(railPlacement(at({ insets: { top: 0, right: 0, bottom: 34, left: 84 } }))).toMatchObject({ side: "left", width: 84 });
  });

  it.each<[string, Partial<PlacementInput>]>([
    ["a wide layout (desktop, the Duo unfolded in landscape)", { compact: false }],
    ["a wide layout even with the Duo's insets", { compact: false, insets: DUO.insets }],
    ["no insets (a browser, the Duo unfolded, Split View)", { insets: { top: 0, right: 0, bottom: 0, left: 0 } }],
    ["an iPhone in portrait (top inset, no side strip)", { insets: { top: 62, right: 0, bottom: 34, left: 0 } }],
    ["the Duo with its status bar moved to the top", { insets: { top: 82, right: 0, bottom: 34, left: 0 } }],
    ["a top inset beside the strip", { insets: { top: 20, right: 84, bottom: 34, left: 0 } }],
    ["an iPhone in landscape (a strip on both sides)", { insets: { top: 0, right: 59, bottom: 21, left: 59 } }],
    ["a strip too narrow for a 44 pt button", { insets: { top: 0, right: 30, bottom: 34, left: 0 } }],
  ])("draws nothing on %s", (_, change) => {
    expect(railPlacement(at(change))).toBeNull();
  });

  it("starts the column at the camera clearance setting", () => {
    expect(railPlacement(at({ cameraClearance: 220 }))?.top).toBe(220);
    expect(railPlacement(at({ cameraClearance: 0 }))?.top).toBe(0);
  });

  it("draws nothing when the column would not fit above the bottom inset", () => {
    // 3 buttons of 48 with two 12 pt gaps is 168 pt; 678 − 34 leaves room from 476 down.
    expect(railPlacement(at({ cameraClearance: 476 }))).not.toBeNull();
    expect(railPlacement(at({ cameraClearance: 477 }))).toBeNull();
    // The keyboard shrinks the page: no clipped rail.
    expect(railPlacement(at({ viewportHeight: 300 }))).toBeNull();
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
});
