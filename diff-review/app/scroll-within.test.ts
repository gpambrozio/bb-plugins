import { describe, expect, it } from "vitest";

import { scrollDelta, scrollWithin } from "./scroll-within";

/** A box from `top` to `bottom`, as `getBoundingClientRect` gives it. */
const box = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) }) as unknown as Element;

describe("scrolling the tab's own area", () => {
  const root = box(100, 500);

  it("puts an element's top at the top, or its middle in the middle", () => {
    expect(scrollDelta(box(700, 760), root, "start")).toBe(600);
    expect(scrollDelta(box(700, 760), root, "center")).toBe(430);
  });

  it("scrolls as little as shows it: none when in view, its bottom up when below, its top down when above", () => {
    expect(scrollDelta(box(200, 300), root, "nearest")).toBe(0);
    expect(scrollDelta(box(550, 600), root, "nearest")).toBe(100);
    expect(scrollDelta(box(40, 90), root, "nearest")).toBe(-60);
    // Taller than the view: its top, not its bottom.
    expect(scrollDelta(box(300, 1000), root, "nearest")).toBe(200);
  });

  it("moves the root's scroll position and nothing else", () => {
    const scroller = { ...box(100, 500), scrollTop: 40 } as unknown as Element;
    scrollWithin(scroller, box(700, 760), "start");
    expect(scroller.scrollTop).toBe(640);
  });
});
