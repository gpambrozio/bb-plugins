/**
 * Where the tab is scrolled, as a file and an offset into it rather than a pixel count, so it comes
 * back to the same place after the diff changed above it. Patches load as their files come near the
 * screen, which moves everything below them; after a restore, the place is held while the layout
 * settles (`holdWithin`), until the user scrolls or clicks, or a step or a reveal scrolls elsewhere.
 */
import { useLayoutEffect } from "react";

import type { ScrollAnchor } from "../shared/types";
import { holdWithin } from "./scroll-within";

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
 * How far `root` must scroll to be at `anchor`: its file, or, when that file left the diff, the one now
 * at its index (the last if fewer are left); null when there is no file.
 */
export function anchorDelta(root: Element, anchor: ScrollAnchor): number | null {
  if (anchor.path === null) return anchor.offset - root.scrollTop;
  const sections = fileSections(root);
  const section = sections.find((element) => element.dataset.filePath === anchor.path) ?? sections[Math.min(anchor.index, sections.length - 1)];
  if (section === undefined) return null;
  return section.getBoundingClientRect().top - root.getBoundingClientRect().top + anchor.offset;
}

/** Scrolls `root` to `anchor` (see `anchorDelta`). */
export function applyAnchor(root: Element, anchor: ScrollAnchor): void {
  const delta = anchorDelta(root, anchor);
  if (delta !== null && Math.abs(delta) >= 1) root.scrollTop += delta;
}

/** Restores `initial` once `root` is there, holds it while the layout settles, then reports each new place to `onPlace`. */
export function useScrollMemory(root: HTMLElement | null, initial: ScrollAnchor | null, onPlace: (anchor: ScrollAnchor) => void): void {
  useLayoutEffect(() => {
    if (root === null) return;
    let settling = false;
    let endHold: () => void = () => undefined;
    if (initial !== null) {
      applyAnchor(root, initial);
      settling = true;
      endHold = holdWithin(
        root,
        () => anchorDelta(root, initial),
        () => {
          settling = false;
        },
      );
    }
    const raf = typeof window.requestAnimationFrame === "function";
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
    return () => {
      endHold();
      root.removeEventListener("scroll", onScroll);
    };
    // `initial` and `onPlace` are read once, when the root appears.
  }, [root]);
}
