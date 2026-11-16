/**
 * The corner stack every plugin's floating pill shares, so two pills drawn from
 * `app.slots.experimental_appOverlay` sit one above the other instead of on top
 * of each other. The convention is in the repository's AGENTS.md: one element
 * with the id below on `document.body`, created by whichever pill mounts first
 * and removed once the last one leaves. Each plugin keeps its own copy of this
 * helper, since plugins are bundled separately, so its styles are set inline:
 * a Tailwind class one plugin relies on may not exist in another's CSS.
 */
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PILL_STACK_ID = "bb-plugin-pill-stack";

/** Below this width bb's composer sits at the bottom, so the stack sits above it. */
const NARROW_QUERY = "(max-width: 639px)";

/** This pill's place in the stack; lower sits closer to the corner, and FirstMate voice's is 10. */
export const SCREEN_SHARING_PILL_ORDER = 20;

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

/** This plugin's id, which its bundled CSS is scoped to. */
export const PLUGIN_ID = "screen-sharing";

/**
 * What a pill's root carries in the stack: its order, clicks back on (the stack
 * lets them through), and the plugin's CSS scope. bb scopes each plugin's CSS
 * to the plugin's root, and the stack is outside it and shared, so the scope
 * goes on the pill and never on the stack.
 */
export function pillRootProps(order: number): {
  "data-pill-order": number;
  "data-bb-plugin-root": "";
  "data-bb-plugin": string;
  style: CSSProperties;
} {
  return { "data-pill-order": order, "data-bb-plugin-root": "", "data-bb-plugin": PLUGIN_ID, style: { order, pointerEvents: "auto" } };
}

/**
 * Renders `children` into the shared stack while mounted. Mount it only while
 * the pill shows, so the stack goes when the pill does. Another plugin's pill
 * leaving can remove the stack in the moment before this one's portal lands in
 * it, so a stack found detached is taken again.
 */
export function PillStackPortal({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (stack !== null && stack.isConnected) return;
    setStack(acquirePillStack());
  });

  // A passive effect, so that on unmount the release runs after React has taken
  // the pill out of the stack (a layout clean-up runs while it is still there).
  // Every mounted pill keeps the corner right, so it stays right after the pill
  // that created the stack has gone.
  useEffect(() => {
    if (stack === null) return;
    const view = stack.ownerDocument.defaultView;
    const query = view?.matchMedia?.(NARROW_QUERY);
    const onChange = () => place(stack, isNarrow(view));
    onChange();
    query?.addEventListener("change", onChange);
    return () => {
      query?.removeEventListener("change", onChange);
      releasePillStack(stack);
    };
  }, [stack]);

  return stack === null ? null : createPortal(children, stack);
}
