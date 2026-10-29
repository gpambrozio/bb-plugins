// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusThread } from "./comment-nav";

/** Each scroll the tab made, by the thread card it scrolled to. */
const scrolls = vi.hoisted(() => [] as string[]);
vi.mock("./scroll-within", () => ({
  scrollWithin: (_root: Element, element: Element) => scrolls.push(element.getAttribute("data-thread-id") ?? "?"),
}));

describe("moving the focus to a thread", () => {
  // Frames run by hand.
  let frames: (() => void)[];
  const runFrames = (count: number) => {
    for (let index = 0; index < count; index++) {
      const due = frames;
      frames = [];
      for (const callback of due) callback();
    }
  };
  beforeEach(() => {
    frames = [];
    scrolls.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const card = (root: HTMLElement, id: string) => {
    const element = Object.assign(document.createElement("div"), { tabIndex: -1 });
    element.setAttribute("data-thread-id", id);
    root.append(element);
    return element;
  };
  const scrollArea = () => document.body.appendChild(document.createElement("div"));

  it("drops an older step still waiting for its card once a newer one starts", () => {
    const root = scrollArea();
    // A, whose file is still mounting; then B, already drawn.
    focusThread(root, "aaaaaa00000a");
    runFrames(2);
    const b = card(root, "aaaaaa00000b");
    focusThread(root, "aaaaaa00000b");
    runFrames(3);
    expect(document.activeElement).toBe(b);
    // A's card mounts late: nothing scrolls or moves to it.
    card(root, "aaaaaa00000a");
    runFrames(10);
    expect(scrolls).toEqual(["aaaaaa00000b"]);
    expect(document.activeElement).toBe(b);
    expect(frames).toEqual([]);
  });

  it("drops a step whose card is drawn but not yet focused when a newer one starts", () => {
    const root = scrollArea();
    card(root, "aaaaaa00000a");
    focusThread(root, "aaaaaa00000a");
    runFrames(1);
    const b = card(root, "aaaaaa00000b");
    focusThread(root, "aaaaaa00000b");
    runFrames(5);
    expect(scrolls).toEqual(["aaaaaa00000b"]);
    expect(document.activeElement).toBe(b);
  });

  it("gives up when the user scrolls or clicks in the area before the card is there", () => {
    for (const type of ["wheel", "pointerdown"]) {
      const root = scrollArea();
      focusThread(root, "aaaaaa00000a");
      runFrames(1);
      root.dispatchEvent(new Event(type));
      const a = card(root, "aaaaaa00000a");
      runFrames(5);
      expect(scrolls).toEqual([]);
      expect(document.activeElement).not.toBe(a);
    }
  });
});
