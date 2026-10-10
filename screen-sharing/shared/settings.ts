/**
 * The settings bb renders as a form (`bb.settings.define(SETTINGS)`). Only the
 * app reads them, through `useSettings()`, when the page is open. Settings
 * changes do not reload the plugin; the page picks a change up as it renders.
 *
 * Only a type is imported from the SDK, so the app may import this module.
 */
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";

/** How many times 1× the Mac scrolls: 1× is one wheel step per 20 px of scrolling (app/wheel.ts). */
export const SCROLL_SPEEDS = ["1", "2", "3", "4", "5"] as const;
export const DEFAULT_SCROLL_SPEED = 3;

export const SETTINGS = {
  scrollSpeed: {
    type: "select",
    label: "Scroll speed",
    description:
      "How far the shared Mac scrolls for a swipe or a turn of the wheel, from 1 (slowest) to 5. Raise it if pages scroll too little, lower it if they jump.",
    options: [...SCROLL_SPEEDS],
    default: String(DEFAULT_SCROLL_SPEED),
  },
} satisfies Record<string, PluginSettingDescriptor>;

/** `useSettings().values` is undefined while loading and loosely typed; this reads the scroll speed safely. */
export function scrollSpeedOf(values: Record<string, string | number | boolean> | undefined): number {
  const speed = Number(values?.scrollSpeed);
  return Number.isInteger(speed) && speed >= 1 && speed <= SCROLL_SPEEDS.length ? speed : DEFAULT_SCROLL_SPEED;
}
