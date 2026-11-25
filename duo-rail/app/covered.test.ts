// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isCovered, leavesStripEmpty, type PaddingOf, type Strip } from "./covered";

// The folded Duo's cover screen: 466 pt wide, the strip the right 84 pt, the rail's buttons at x 400–448.
const WIDTH = 466;
const RIGHT: Strip = { side: "right", width: 84 };
const LEFT: Strip = { side: "left", width: 84 };

function setBox(element: Element, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

function railWithButtons(count: number, left = 400): HTMLElement {
  const rail = document.createElement("nav");
  for (let i = 0; i < count; i += 1) {
    const button = document.createElement("button");
    button.appendChild(document.createElement("span"));
    setBox(button, left, 175 + i * 60, 48, 48);
    rail.appendChild(button);
  }
  document.body.appendChild(rail);
  return rail;
}

/** A full-screen element (bb's page, its tool panel, or the drawer's layer) with `pad` pt of padding on one side. */
function layer(pad: { right?: number; left?: number }, left = 0): { element: HTMLElement; paddingOf: PaddingOf } {
  const element = document.createElement("div");
  element.appendChild(document.createElement("p"));
  setBox(element, left, 0, WIDTH, 678);
  document.body.appendChild(element);
  return { element, paddingOf: (node, side) => (node === element ? (pad[side] ?? 0) : 0) };
}

/** The browser's stack at a point: the rail's button when the point is on one, then whatever is under the rail. */
function stack(rail: Element, under: Element[]) {
  return (x: number, y: number) => {
    const button = Array.from(rail.querySelectorAll("button")).find((b) => {
      const box = b.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
    return [...(button ? [button.firstElementChild!, button, rail] : []), ...under];
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isCovered", () => {
  it("is false over bb's page, which pads itself out of the strip", () => {
    const rail = railWithButtons(3);
    const page = layer({ right: 84 });
    expect(isCovered(rail, RIGHT, stack(rail, [page.element, document.body]), page.paddingOf)).toBe(false);
  });

  it("is false over the full-page tool panel a thread's right pane opens as on the folded screen (the owner's bug)", () => {
    // bb's compact tool panel is a fixed, opaque layer over the whole page, padded out of the strip like the page.
    const rail = railWithButtons(3);
    const page = layer({ right: 84 });
    const panel = layer({ right: 84 });
    const paddingOf: PaddingOf = (node, side) => Math.max(page.paddingOf(node, side), panel.paddingOf(node, side));
    expect(isCovered(rail, RIGHT, stack(rail, [panel.element.firstElementChild!, panel.element, page.element]), paddingOf)).toBe(false);
  });

  it("is true over bb's sidebar drawer's tap-to-close layer, which has slid the page into the strip", () => {
    const rail = railWithButtons(3);
    const page = layer({ right: 84 }, 360);
    const scrim = layer({}, 360);
    const paddingOf: PaddingOf = (node, side) => Math.max(page.paddingOf(node, side), scrim.paddingOf(node, side));
    expect(isCovered(rail, RIGHT, stack(rail, [scrim.element, page.element]), paddingOf)).toBe(true);
  });

  it("is true when a layer is drawn over a button (a sheet or menu)", () => {
    const rail = railWithButtons(3);
    const page = layer({ right: 84 });
    const sheet = document.createElement("div");
    const buttons = Array.from(rail.querySelectorAll("button"));
    // Over the last button only: one covered button is enough.
    const stackAt = (x: number, y: number) => (y > 300 ? [sheet, buttons[2]!, rail, page.element] : stack(rail, [page.element])(x, y));
    expect(isCovered(rail, RIGHT, stackAt, page.paddingOf)).toBe(true);
  });

  it("is true over padding narrower than the strip, or padding that does not reach the button", () => {
    const rail = railWithButtons(1);
    const narrow = layer({ right: 40 });
    expect(isCovered(rail, RIGHT, stack(rail, [narrow.element]), narrow.paddingOf)).toBe(true);
    // Padded by the strip, but on the other side.
    const wrongSide = layer({ left: 84 });
    expect(isCovered(rail, RIGHT, stack(rail, [wrongSide.element]), wrongSide.paddingOf)).toBe(true);
  });

  it("follows the strip to the left on a mirrored device", () => {
    const rail = railWithButtons(1, 18);
    const page = layer({ left: 84 });
    expect(isCovered(rail, LEFT, stack(rail, [page.element]), page.paddingOf)).toBe(false);
    expect(isCovered(rail, RIGHT, stack(rail, [page.element]), page.paddingOf)).toBe(true);
  });

  it("is false when only the document is under the rail (a menu has set the page's pointer-events to none)", () => {
    const rail = railWithButtons(2);
    expect(isCovered(rail, RIGHT, stack(rail, [document.body, document.documentElement]))).toBe(false);
    expect(isCovered(rail, RIGHT, stack(rail, [document.documentElement]))).toBe(false);
  });

  it("is true when nothing is there to hit (off screen)", () => {
    const rail = railWithButtons(1);
    expect(isCovered(rail, RIGHT, () => [])).toBe(true);
  });

  it("ignores buttons that are not laid out", () => {
    const rail = document.createElement("nav");
    rail.appendChild(document.createElement("button"));
    expect(isCovered(rail, RIGHT, () => [])).toBe(false);
  });
});

describe("leavesStripEmpty", () => {
  it("finds the padding on an ancestor of what was hit", () => {
    const page = layer({ right: 84 });
    expect(leavesStripEmpty(page.element.firstElementChild!, 424, RIGHT, page.paddingOf)).toBe(true);
    expect(leavesStripEmpty(page.element.firstElementChild!, 300, RIGHT, page.paddingOf)).toBe(false);
  });

  it("reads computed padding by default", () => {
    const page = layer({});
    page.element.style.paddingRight = "84px";
    expect(leavesStripEmpty(page.element, 424, RIGHT)).toBe(true);
    page.element.style.paddingRight = "12px";
    expect(leavesStripEmpty(page.element, 424, RIGHT)).toBe(false);
  });
});
