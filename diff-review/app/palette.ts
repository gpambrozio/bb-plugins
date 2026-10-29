/**
 * The colour-blind diff palette (diffity's, after GitHub's): blue for added lines and orange for
 * removed ones, in place of green and red. Pierre derives every add/remove colour of a diff from two
 * custom properties, which reach into its shadow DOM from any ancestor, so the palette is a style on
 * the diff's wrapper. It changes only this plugin's diffs, not bb's own diff panel.
 *
 * Colour values from diffity's `src/styles/app.css` (https://github.com/nilbuild/diffity, MIT).
 */
import type { CSSProperties } from "react";

export const COLOR_BLIND_SETTING = "colorBlindDiffs";

const COLOURS = {
  light: { added: "#0969da", deleted: "#bc4c00" },
  dark: { added: "#58a6ff", deleted: "#f0883e" },
} as const;

/** The wrapper style for a diff in `mode`, or undefined for Pierre's own colours. */
export function paletteStyle(colorBlind: boolean, mode: "light" | "dark"): CSSProperties | undefined {
  if (!colorBlind) return undefined;
  const colours = COLOURS[mode];
  return { "--diffs-addition-color-override": colours.added, "--diffs-deletion-color-override": colours.deleted } as CSSProperties;
}
