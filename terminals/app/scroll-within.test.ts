// @vitest-environment jsdom
/** Keeping a list's active row in sight without scrolling anything around the list. */
import { describe, expect, it } from "vitest";

import { revealDelta, revealWithin } from "./scroll-within";

function box(top: number, height: number): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => new DOMRect(0, top, 100, height);
  return element;
}

describe("revealDelta", () => {
  const list = box(100, 90);

  it("is nothing for a row that shows whole", () => {
    expect(revealDelta(box(100, 30), list)).toBe(0);
    expect(revealDelta(box(160, 30), list)).toBe(0);
  });

  it("scrolls up to a row above the view, and down by as little as shows a row below it", () => {
    expect(revealDelta(box(70, 30), list)).toBe(-30);
    expect(revealDelta(box(175, 30), list)).toBe(15);
  });

  it("brings a row taller than the view to its top", () => {
    expect(revealDelta(box(150, 200), list)).toBe(50);
  });
});

describe("revealWithin", () => {
  it("moves only the list's own scroll position", () => {
    const outer = document.createElement("div");
    const list = box(100, 90);
    outer.append(list);
    list.scrollTop = 0;
    revealWithin(box(220, 30), list);
    expect(list.scrollTop).toBe(60);
    expect(outer.scrollTop).toBe(0);
  });
});
