import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdWithin, scrollDelta, scrollWithin } from "./scroll-within";

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

describe("holding a place while the layout settles", () => {
  // Frames run by hand, at a clock the test sets.
  let frames: Map<number, () => void>;
  let now: number;
  const runFrame = (advance = 16) => {
    now += advance;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback();
  };
  beforeEach(() => {
    frames = new Map();
    now = 0;
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const scroller = () => Object.assign(new EventTarget(), { isConnected: true, scrollTop: 100 }) as unknown as Element;

  it("scrolls after the place on each frame, and ends once nothing moved it for a while", () => {
    const root = scroller();
    let drift = 0;
    const onEnd = vi.fn();
    holdWithin(root, () => drift, onEnd);
    runFrame();
    drift = 665;
    runFrame();
    expect(root.scrollTop).toBe(765);
    drift = 0;
    runFrame(2_900);
    expect(onEnd).not.toHaveBeenCalled();
    runFrame(200);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("ends when the user scrolls, clicks or types, when the place is gone, or when another hold starts", () => {
    for (const end of ["wheel", "pointerdown", "keydown"]) {
      const root = scroller();
      const onEnd = vi.fn();
      holdWithin(root, () => 50, onEnd);
      root.dispatchEvent(new Event(end));
      expect(onEnd).toHaveBeenCalledOnce();
      runFrame();
      expect(root.scrollTop).toBe(100);
    }
    const root = scroller();
    const gone = vi.fn();
    holdWithin(root, () => null, gone);
    runFrame();
    expect(gone).toHaveBeenCalledOnce();
    const first = vi.fn();
    holdWithin(root, () => 50, first);
    holdWithin(root, () => 0);
    expect(first).toHaveBeenCalledOnce();
    runFrame();
    expect(root.scrollTop).toBe(100);
  });
});
