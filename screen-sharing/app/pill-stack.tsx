/**
 * The corner stack every plugin's floating pill shares, so two pills drawn from
 * `app.slots.experimental_appOverlay` sit one above the other instead of on top
 * of each other. The convention is in the repository's AGENTS.md: one element
 * with the id below on `document.body`, created by whichever pill mounts first
 * and removed once the last one leaves. Each plugin keeps its own copy of this
 * helper, since plugins are bundled separately, so its styles are set inline:
 * a Tailwind class one plugin relies on may not exist in another's CSS.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePortalScopeProps } from "@/lib/portal-scope";

export const PILL_STACK_ID = "bb-plugin-pill-stack";

/** Below this width bb's composer sits at the bottom, so the stack sits above it. */
const NARROW_QUERY = "(max-width: 639px)";

/** Lower sits closer to the corner. */
export const PILL_ORDER = { voice: 10, screenSharing: 20 } as const;

function place(stack: HTMLElement, narrow: boolean): void {
  stack.style.bottom = narrow ? "96px" : "16px";
  stack.style.right = narrow ? "12px" : "16px";
}

function isNarrow(view: Window | null): boolean {
  return view?.matchMedia?.(NARROW_QUERY).matches ?? false;
}

/** The shared stack, created on `doc.body` if no plugin has made it yet. */
export function acquirePillStack(doc: Document = document): HTMLElement {
  const existing = doc.getElementById(PILL_STACK_ID);
  if (existing) return existing;
  const stack = doc.createElement("div");
  stack.id = PILL_STACK_ID;
  Object.assign(stack.style, {
    position: "fixed",
    zIndex: "50",
    display: "flex",
    flexDirection: "column-reverse",
    alignItems: "flex-end",
    gap: "8px",
    pointerEvents: "none",
    maxWidth: "calc(100vw - 24px)",
  });
  place(stack, isNarrow(doc.defaultView));
  doc.body.appendChild(stack);
  return stack;
}

/** Removes the stack once no pill is left in it; another plugin's pill keeps it. */
export function releasePillStack(stack: HTMLElement): void {
  if (stack.childElementCount === 0) stack.remove();
}

/**
 * Renders `children` into the shared stack while mounted. The pill's root sets
 * `data-pill-order` and `pointer-events: auto` itself ({@link usePillRootProps}).
 * Mount it only while the pill shows, so an empty stack is never left behind.
 */
export function PillStackPortal({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const acquired = acquirePillStack();
    setStack(acquired);
    // Every mounted pill keeps the position current, so it stays right after the
    // pill that created the stack has gone.
    const query = window.matchMedia?.(NARROW_QUERY);
    const onChange = () => place(acquired, isNarrow(window));
    onChange();
    query?.addEventListener("change", onChange);
    return () => {
      query?.removeEventListener("change", onChange);
      // Passive clean-up runs after React has taken the portal's nodes out.
      releasePillStack(acquired);
    };
  }, []);
  return stack ? createPortal(children, stack) : null;
}

/**
 * What a pill's root carries to take its place in the stack. The stack is
 * outside the plugin root this plugin's CSS is scoped to, so the root also
 * carries the portal scope that brings its classes back.
 */
export function usePillRootProps(order: number) {
  return {
    ...usePortalScopeProps(),
    "data-pill-order": String(order),
    style: { order, pointerEvents: "auto" as const },
  };
}
