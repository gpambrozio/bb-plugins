/**
 * An unknown icon name does not fail anywhere — bb draws its generic bolt instead — so this is where it
 * fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SHIP_ICON } from "./icons";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  bb: { branding: { experimental_icons?: Record<string, string> } };
};

describe("the tab's icon", () => {
  it("is one this plugin declares, under its own id", () => {
    const [pluginId, name] = SHIP_ICON.split("/");
    expect(pluginId).toBe(manifest.name.split("/").pop()?.replace(/^bb-plugin-/, ""));
    const file = manifest.bb.branding.experimental_icons?.[name ?? ""];
    expect(file).toBeDefined();
    expect(existsSync(join(root, file ?? ""))).toBe(true);
  });
});
