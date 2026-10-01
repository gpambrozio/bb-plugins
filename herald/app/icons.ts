/**
 * The icons Herald draws. bb's built-in set has no speaker or megaphone, so
 * those three are SVGs this plugin declares in `bb.branding.experimental_icons`
 * and names as `"<pluginId>/<name>"`. A name bb does not know renders as its
 * generic bolt, silently — `icons.test.ts` checks every name used here against
 * bb's built-in list and the manifest.
 */
export const HERALD_ICONS = {
  megaphone: "herald/megaphone",
  volume: "herald/volume",
  volumeOff: "herald/volume-off",
} as const;
