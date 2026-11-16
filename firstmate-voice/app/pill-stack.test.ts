// @vitest-environment jsdom
/**
 * The shared pill stack: one fixed element at the bottom-right corner that every plugin's pill portals into, made
 * by the first pill, reused by the others (another plugin's copy of this helper included) and removed by the last
 * one to leave.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PILL_STACK_ID,
  PILL_STACK_NARROW_QUERY,
  PLUGIN_ID,
  PillStackPortal,
  VOICE_PILL_ORDER,
  acquirePillStack,
  pillRootProps,
  releasePillStack,
} from "./pill-stack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no matchMedia: a narrow-width query the test can flip. */
function fakeWidth(narrow: boolean): { set(narrow: boolean): void } {
  const listeners = new Set<() => void>();
  const query = {
    media: PILL_STACK_NARROW_QUERY,
    matches: narrow,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  window.matchMedia = ((media: string) => {
    expect(media).toBe(PILL_STACK_NARROW_QUERY);
    return query;
  }) as unknown as typeof window.matchMedia;
  return {
    set(next) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function stack(): HTMLElement | null {
  return document.getElementById(PILL_STACK_ID);
}

let roots: Root[] = [];

function mount(children: ReactNode): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(PillStackPortal, null, children)));
  return root;
}

function pill(order: number, text: string): ReactNode {
  return createElement("div", { ...pillRootProps(order), "data-testid": text }, text);
}

beforeEach(() => {
  fakeWidth(false);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
});

describe("the shared pill stack", () => {
  it("is made once on the body, fixed at the bottom-right corner, with every style inline", () => {
    const container = acquirePillStack();
    expect(container.parentElement).toBe(document.body);
    expect(container.id).toBe(PILL_STACK_ID);
    expect(container.className).toBe("");
    expect(container.style).toMatchObject({
      position: "fixed",
      bottom: "16px",
      right: "16px",
      zIndex: "50",
      display: "flex",
      flexDirection: "column-reverse",
      alignItems: "flex-end",
      gap: "8px",
      pointerEvents: "none",
      maxWidth: "calc(100vw - 24px)",
    });
    expect(acquirePillStack()).toBe(container);
    expect(document.querySelectorAll(`#${PILL_STACK_ID}`)).toHaveLength(1);
  });

  it("reuses a stack another plugin made", () => {
    const theirs = document.createElement("div");
    theirs.id = PILL_STACK_ID;
    document.body.appendChild(theirs);
    expect(acquirePillStack()).toBe(theirs);
  });

  it("rises above bb's composer on a narrow window", () => {
    fakeWidth(true);
    expect(acquirePillStack().style).toMatchObject({ bottom: "96px", right: "12px" });
  });

  it("goes when the last pill leaves it, and stays while one is left", () => {
    const container = acquirePillStack();
    const left = document.createElement("div");
    container.appendChild(left);
    releasePillStack(container);
    expect(stack()).toBe(container);
    left.remove();
    releasePillStack(container);
    expect(stack()).toBeNull();
  });

  it("marks the voice pill's root with its order, clicks and this plugin's CSS scope", () => {
    expect(VOICE_PILL_ORDER).toBe(10);
    expect(pillRootProps(VOICE_PILL_ORDER)).toEqual({
      "data-pill-order": 10,
      "data-bb-plugin-root": "",
      "data-bb-plugin": PLUGIN_ID,
      style: { order: 10, pointerEvents: "auto" },
    });
  });
});

describe("a pill in the stack", () => {
  it("renders into the stack, beside another plugin's pill, and the stack goes with the last of them", () => {
    const voice = mount(pill(VOICE_PILL_ORDER, "voice"));
    const container = stack();
    expect(container).not.toBeNull();
    const shown = container!.querySelector<HTMLElement>("[data-testid=voice]")!;
    expect(shown.dataset.pillOrder).toBe("10");
    expect(shown.style.order).toBe("10");
    expect(shown.style.pointerEvents).toBe("auto");
    expect(shown.dataset.bbPlugin).toBe(PLUGIN_ID);

    // Screen Sharing's pill, at 20, joins the same stack.
    const sharing = mount(pill(20, "sharing"));
    expect(stack()).toBe(container);
    expect([...container!.children].map((child) => (child as HTMLElement).dataset.testid)).toEqual(["voice", "sharing"]);

    act(() => voice.unmount());
    expect(stack()).toBe(container);
    expect(container!.children).toHaveLength(1);
    act(() => sharing.unmount());
    expect(stack()).toBeNull();
  });

  it("follows the window across the narrow width while it shows", () => {
    const width = fakeWidth(false);
    mount(pill(VOICE_PILL_ORDER, "voice"));
    width.set(true);
    expect(stack()!.style).toMatchObject({ bottom: "96px", right: "12px" });
    width.set(false);
    expect(stack()!.style).toMatchObject({ bottom: "16px", right: "16px" });
  });

  it("takes the stack again when another pill's leaving removed it", () => {
    const voice = mount(pill(VOICE_PILL_ORDER, "voice"));
    const first = stack()!;
    first.remove();
    act(() => voice.render(createElement(PillStackPortal, null, pill(VOICE_PILL_ORDER, "voice"))));
    const second = stack();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.querySelector("[data-testid=voice]")).not.toBeNull();
  });
});
