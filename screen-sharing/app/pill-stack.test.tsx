// @vitest-environment jsdom
/**
 * The corner stack plugins' pills share: the first pill creates it, a later one
 * reuses it, and it goes when the last pill leaves — not while another
 * plugin's pill is still in it.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PILL_STACK_ID, PillStackPortal, acquirePillStack, releasePillStack, pillRootProps } from "./pill-stack";

afterEach(() => {
  cleanup();
  document.getElementById(PILL_STACK_ID)?.remove();
});

function stack(): HTMLElement | null {
  return document.getElementById(PILL_STACK_ID);
}

function Pill({ name, order }: { name: string; order: number }) {
  return (
    <PillStackPortal>
      <div role="status" aria-label={name} {...pillRootProps(order)} />
    </PillStackPortal>
  );
}

describe("the shared stack", () => {
  it("is created on the body, fixed in the corner, when none exists", () => {
    const created = acquirePillStack();
    expect(created.parentElement).toBe(document.body);
    expect(created.style).toMatchObject({
      position: "fixed",
      bottom: "16px",
      right: "16px",
      zIndex: "50",
      display: "flex",
      flexDirection: "column-reverse",
      pointerEvents: "none",
    });
  });

  it("is reused when another plugin made it first", () => {
    const theirs = document.createElement("div");
    theirs.id = PILL_STACK_ID;
    document.body.appendChild(theirs);
    expect(acquirePillStack()).toBe(theirs);
    expect(document.querySelectorAll(`#${PILL_STACK_ID}`)).toHaveLength(1);
  });

  it("is removed only once it is empty", () => {
    const created = acquirePillStack();
    const pill = document.createElement("div");
    created.appendChild(pill);
    releasePillStack(created);
    expect(stack()).toBe(created);
    pill.remove();
    releasePillStack(created);
    expect(stack()).toBeNull();
  });
});

describe("a pill in the stack", () => {
  it("renders inside it with its order and takes clicks", () => {
    render(<Pill name="ours" order={20} />);
    const pill = stack()?.querySelector('[aria-label="ours"]') as HTMLElement;
    expect(pill.dataset.pillOrder).toBe("20");
    expect(pill.style.order).toBe("20");
    expect(pill.style.pointerEvents).toBe("auto");
    // bb scopes this plugin's CSS to its root, which the shared stack is outside of.
    expect(pill.dataset.bbPlugin).toBe("screen-sharing");
    expect(pill.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(stack()?.hasAttribute("data-bb-plugin")).toBe(false);
    expect(stack()?.hasAttribute("data-bb-plugin-root")).toBe(false);
  });

  it("shares the stack with another plugin's pill and leaves it to that pill", () => {
    const theirs = document.createElement("div");
    const ours = render(<Pill name="ours" order={20} />);
    stack()?.appendChild(theirs);
    ours.unmount();
    expect(stack()?.children).toHaveLength(1);
    theirs.remove();
  });

  it("takes a fresh stack when another plugin removed the one it held", () => {
    const ours = render(<Pill name="ours" order={20} />);
    const first = stack();
    first?.remove();
    ours.rerender(<Pill name="ours" order={20} />);
    expect(stack()).not.toBe(first);
    expect(stack()?.querySelector('[aria-label="ours"]')).not.toBeNull();
  });

  it("takes the stack away when it was the last pill", () => {
    const ours = render(<Pill name="ours" order={20} />);
    expect(stack()).not.toBeNull();
    ours.unmount();
    expect(stack()).toBeNull();
  });
});
