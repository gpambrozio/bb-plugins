/**
 * Copied from bb's bundled Navigation plugin so the rail looks and behaves
 * like bb's own. Source: get-bb/bb at desktop-v0.48.1 (commit
 * e003e9510cbfd3bb6c26a28630b46ffb1c242a44; unchanged at desktop-v0.49.0),
 * plugins/navigation/app/target.ts. MIT licence, notice in ./LICENSE.
 *
 * Unchanged.
 */
import type { MouseEvent } from "react";
import type { ExperimentalSidebarNavigationTarget } from "@get-bb/plugin-sdk/app";

export function isNewViewClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function clickTarget(
  event: MouseEvent,
): ExperimentalSidebarNavigationTarget {
  return isNewViewClick(event) ? "split" : "current";
}
