/**
 * An unknown icon name does not fail anywhere — bb draws its generic bolt
 * instead — so this is where it fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SKILLS_ICON } from "./icons";
import { BB_ICON_NAMES } from "./testing/bb-icon-names";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  bb: { branding: { icon: string } };
};

describe("icon names", () => {
  it("draws a bb built-in", () => {
    expect(BB_ICON_NAMES).toContain(SKILLS_ICON);
  });

  it("brands the plugin with the same icon", () => {
    expect(manifest.bb.branding.icon).toBe(SKILLS_ICON);
  });
});
