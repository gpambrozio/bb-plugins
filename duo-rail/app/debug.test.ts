import { describe, expect, it } from "vitest";

import { debugLines, type DebugNumbers } from "./debug";

const folded: DebugNumbers = {
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  inner: { width: 466, height: 678 },
  visual: { width: 466, height: 678, offsetTop: 0, offsetLeft: 0 },
  screen: { width: 466, height: 678 },
  devicePixelRatio: 3,
};

describe("debugLines", () => {
  it("lists the display, the gap in use, the insets, and every size the page can read", () => {
    expect(debugLines(folded, { display: "folded", gap: 175 })).toEqual([
      "folded",
      "gap 175",
      "inset t0 r84",
      "inset b34 l0",
      "win 466×678",
      "vv 466×678",
      "vv@ t0 l0",
      "scr 466×678",
      "dpr 3",
    ]);
  });

  it("keeps one decimal of a fractional value", () => {
    const lines = debugLines({ ...folded, insets: { top: 0, right: 84.333, bottom: 20.66, left: 0 }, devicePixelRatio: 2.625 }, { display: "unfolded", gap: 110 });
    expect(lines).toContain("inset t0 r84.3");
    expect(lines).toContain("inset b20.7 l0");
    expect(lines).toContain("dpr 2.6");
  });

  it("says so when the page has no visual viewport", () => {
    const lines = debugLines({ ...folded, visual: null }, { display: "folded", gap: 175 });
    expect(lines).toContain("vv none");
    expect(lines.some((line) => line.startsWith("vv@"))).toBe(false);
  });

  it("keeps every line within the strip: 15 characters at 8 px in 80 pt", () => {
    const wide: DebugNumbers = {
      insets: { top: 0, right: 85.33, bottom: 21.33, left: 0 },
      inner: { width: 951.5, height: 669.5 },
      visual: { width: 951.5, height: 669.5, offsetTop: 12.5, offsetLeft: 0 },
      screen: { width: 951, height: 669 },
      devicePixelRatio: 3,
    };
    for (const line of debugLines(wide, { display: "unfolded", gap: 110 })) expect(line.length).toBeLessThanOrEqual(15);
  });
});
