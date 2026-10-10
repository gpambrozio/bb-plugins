import { describe, expect, it } from "vitest";

import { DEFAULT_SCROLL_SPEED, SETTINGS, scrollSpeedOf } from "./settings";

describe("the scroll speed setting", () => {
  it("offers 1 to 5, defaulting to 3", () => {
    expect(SETTINGS.scrollSpeed.options).toEqual(["1", "2", "3", "4", "5"]);
    expect(SETTINGS.scrollSpeed.default).toBe("3");
    expect(DEFAULT_SCROLL_SPEED).toBe(3);
  });

  it("reads the chosen speed, and the default for anything else", () => {
    expect(scrollSpeedOf({ scrollSpeed: "5" })).toBe(5);
    expect(scrollSpeedOf({ scrollSpeed: "1" })).toBe(1);
    expect(scrollSpeedOf(undefined)).toBe(3);
    expect(scrollSpeedOf({ scrollSpeed: "9" })).toBe(3);
    expect(scrollSpeedOf({ scrollSpeed: "fast" })).toBe(3);
  });
});
