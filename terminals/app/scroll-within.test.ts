// @vitest-environment jsdom
/** Keeping a list's active row in sight without scrolling anything around the list. */
import { describe, expect, it } from "vitest";

import { revealDelta, revealDeltaX, revealWithin, revealWithinX } from "./scroll-within";

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

function hbox(left: number, width: number): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => new DOMRect(left, 0, width, 28);
  return element;
}

describe("revealDeltaX", () => {
  const strip = hbox(100, 300);

  it("is nothing for a tab that shows whole", () => {
    expect(revealDeltaX(hbox(100, 80), strip)).toBe(0);
    expect(revealDeltaX(hbox(320, 80), strip)).toBe(0);
  });

  it("scrolls left to a tab before the view, and right by as little as shows a tab after it", () => {
    expect(revealDeltaX(hbox(60, 80), strip)).toBe(-40);
    expect(revealDeltaX(hbox(350, 80), strip)).toBe(30);
  });

  it("brings a tab wider than the view to its start", () => {
    expect(revealDeltaX(hbox(150, 400), strip)).toBe(50);
  });
});

describe("revealWithinX", () => {
  it("moves only the strip's own scroll position", () => {
    const outer = document.createElement("div");
    const strip = hbox(100, 300);
    outer.append(strip);
    revealWithinX(hbox(450, 80), strip);
    expect(strip.scrollLeft).toBe(130);
    expect(outer.scrollLeft).toBe(0);
  });
});
