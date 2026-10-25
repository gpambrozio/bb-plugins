/**
 * Where the tab is scrolled, as a file and an offset into it rather than a pixel count, so it comes
 * back to the same place after the diff changed above it. Patches load as their files come near the
 * screen, which moves everything below them; for a few seconds after a restore, until the user scrolls
 * or clicks, the place is applied again on every frame.
 */
import { useLayoutEffect } from "react";

import type { ScrollAnchor } from "../shared/types";

/** How long a restored place is held while patches load around it. */
const SETTLE_MS = 3_000;

const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function fileSections(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("section[data-file-path]"));
}

/** The first file whose bottom is below the top of `root`, and how far into it the top is. */
export function anchorOf(root: Element): ScrollAnchor {
  const top = root.getBoundingClientRect().top;
  const sections = fileSections(root);
  for (const [index, section] of sections.entries()) {
    const box = section.getBoundingClientRect();
    if (box.bottom > top) return { path: section.dataset.filePath ?? null, index, offset: top - box.top };
  }
  return { path: null, index: 0, offset: root.scrollTop };
}

/**
 * Scrolls `root` to `anchor`: its file, or, when that file left the diff, the one now at its index
 * (the last if fewer are left).
 */
export function applyAnchor(root: Element, anchor: ScrollAnchor): void {
  if (anchor.path === null) {
    root.scrollTop = anchor.offset;
    return;
  }
  const sections = fileSections(root);
  const section = sections.find((element) => element.dataset.filePath === anchor.path) ?? sections[Math.min(anchor.index, sections.length - 1)];
  if (section === undefined) return;
  const delta = section.getBoundingClientRect().top - root.getBoundingClientRect().top + anchor.offset;
  if (Math.abs(delta) >= 1) root.scrollTop += delta;
}

/** Restores `initial` once `root` is there, then reports each new place to `onPlace`. */
export function useScrollMemory(root: HTMLElement | null, initial: ScrollAnchor | null, onPlace: (anchor: ScrollAnchor) => void): void {
  useLayoutEffect(() => {
    if (root === null) return;
    let settling = initial !== null;
    if (initial !== null) applyAnchor(root, initial);
    const started = Date.now();
    const raf = typeof window.requestAnimationFrame === "function";
    let frame = 0;
    const hold = () => {
      if (!settling || initial === null) return;
      if (Date.now() - started > SETTLE_MS) {
        settling = false;
        return;
      }
      applyAnchor(root, initial);
      frame = window.requestAnimationFrame(hold);
    };
    if (settling && raf) frame = window.requestAnimationFrame(hold);
    const stopHolding = () => {
      settling = false;
    };

    let measuring = false;
    const onScroll = () => {
      // While a restored place is held, the scrolling is the tab's own.
      if (settling || measuring) return;
      if (!raf) {
        onPlace(anchorOf(root));
        return;
      }
      measuring = true;
      window.requestAnimationFrame(() => {
        measuring = false;
        onPlace(anchorOf(root));
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const type of USER_INPUT) root.addEventListener(type, stopHolding, { passive: true });
    return () => {
      settling = false;
      if (raf) window.cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll);
      for (const type of USER_INPUT) root.removeEventListener(type, stopHolding);
    };
    // `initial` and `onPlace` are read once, when the root appears.
  }, [root]);
}
