// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isCovered } from "./covered";

function railWithButtons(count: number): HTMLElement {
  const rail = document.createElement("nav");
  for (let i = 0; i < count; i += 1) {
    const button = document.createElement("button");
    button.appendChild(document.createElement("span"));
    button.getBoundingClientRect = () => ({ left: 400, top: 175 + i * 60, width: 48, height: 48, right: 448, bottom: 223 + i * 60, x: 400, y: 175 + i * 60, toJSON: () => ({}) });
    rail.appendChild(button);
  }
  document.body.appendChild(rail);
  return rail;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isCovered", () => {
  it("is false when every button is topmost at its centre (a tap lands on its glyph)", () => {
    const rail = railWithButtons(3);
    const buttons = Array.from(rail.querySelectorAll("button"));
    expect(isCovered(rail, (_, y) => buttons[Math.floor((y - 175) / 60)]?.firstElementChild ?? null)).toBe(false);
  });

  it("is true when something else is topmost over a button (bb's drawer layer)", () => {
    const rail = railWithButtons(3);
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    expect(isCovered(rail, () => layer)).toBe(true);
  });

  it("is true when one button of several is covered", () => {
    const rail = railWithButtons(3);
    const buttons = Array.from(rail.querySelectorAll("button"));
    const sheet = document.createElement("div");
    expect(isCovered(rail, (_, y) => (y > 300 ? sheet : buttons[0] ?? null))).toBe(true);
  });

  it("is true when nothing is there to hit (off screen)", () => {
    expect(isCovered(railWithButtons(1), () => null)).toBe(true);
  });

  it("ignores buttons that are not laid out", () => {
    const rail = document.createElement("nav");
    rail.appendChild(document.createElement("button"));
    expect(isCovered(rail, () => null)).toBe(false);
  });
});
