/**
 * The pill stack shared by every plugin's floating pill (FirstMate voice, Screen Sharing's live sessions): one
 * element, `#bb-plugin-pill-stack`, fixed at the bottom-right corner, that each pill portals into so the pills
 * stack instead of overlapping. bb lays out no app overlays (an `experimental_appOverlay` owns its positioning),
 * and plugins are bundled separately, so each plugin carries a copy of this helper and they agree only on the
 * element's id, its inline styles and `data-pill-order`: a lower order sits closer to the corner.
 *
 * Every style is set inline, never with a Tailwind class, since each plugin ships its own CSS. Whichever pill
 * comes first creates the element on `document.body`; a pill that goes and leaves it empty removes it.
 */
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

export const PILL_STACK_ID = "bb-plugin-pill-stack";
/** Where bb's composer sits at the bottom, the stack rises above it. */
export const PILL_STACK_NARROW_QUERY = "(max-width: 639px)";
/** The voice pill's place in the stack; Screen Sharing's is 20. */
export const VOICE_PILL_ORDER = 10;

function place(container: HTMLElement, narrow: boolean): void {
  container.style.bottom = narrow ? "96px" : "16px";
  container.style.right = narrow ? "12px" : "16px";
}

function narrowQuery(doc: Document): MediaQueryList | null {
  return doc.defaultView?.matchMedia?.(PILL_STACK_NARROW_QUERY) ?? null;
}

/** The shared stack, created on the document's body if no pill has made it yet. */
export function acquirePillStack(doc: Document = document): HTMLElement {
  const found = doc.getElementById(PILL_STACK_ID);
  if (found !== null) return found;
  const container = doc.createElement("div");
  container.id = PILL_STACK_ID;
  Object.assign(container.style, {
    position: "fixed",
    zIndex: "50",
    display: "flex",
    flexDirection: "column-reverse",
    alignItems: "flex-end",
    gap: "8px",
    pointerEvents: "none",
    maxWidth: "calc(100vw - 24px)",
  } satisfies Partial<CSSStyleDeclaration>);
  place(container, narrowQuery(doc)?.matches ?? false);
  doc.body.appendChild(container);
  return container;
}

/** Called as a pill leaves: the stack goes too when no pill is left in it. */
export function releasePillStack(container: HTMLElement): void {
  if (container.childElementCount === 0) container.remove();
}

/** Keeps the stack's corner right as the window crosses the narrow width; returns the unsubscribe. */
function followWidth(container: HTMLElement, doc: Document): () => void {
  const query = narrowQuery(doc);
  if (query === null) return () => {};
  const update = () => place(container, query.matches);
  update();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

/** This plugin's id, which its bundled CSS is scoped to. */
export const PLUGIN_ID = "firstmate-voice";

/**
 * The attributes a pill's root carries in the stack: its order, clicks back on (the stack lets them through),
 * and the plugin's CSS scope. bb scopes each plugin's CSS to the plugin's root, and the stack is outside it and
 * shared, so the scope goes on the pill and never on the stack.
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
 * Renders `children` into the shared stack while mounted. Mount it only while the pill shows, so the stack goes
 * when the pill does. Another plugin's pill leaving can remove the stack in the moment before this one's portal
 * lands in it, so a stack found detached is taken again.
 */
export function PillStackPortal({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (container !== null && container.isConnected) return;
    setContainer(acquirePillStack());
  });

  // A passive effect, so that on unmount the release runs after React has taken the pill out of the stack (a
  // layout cleanup runs while the portal's children are still in it).
  useEffect(() => {
    if (container === null) return;
    const stop = followWidth(container, container.ownerDocument);
    return () => {
      stop();
      releasePillStack(container);
    };
  }, [container]);

  return container === null ? null : createPortal(children, container);
}
