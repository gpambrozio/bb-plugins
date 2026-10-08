/**
 * Every icon name the app draws must be one bb knows: a built-in, or one of
 * this plugin's own declared SVGs (`"<pluginId>/<name>"` from
 * `bb.branding.experimental_icons`). An unknown name does not fail anywhere —
 * bb draws its generic bolt instead — so this is where it fails.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BB_ICON_NAMES } from "./testing/bb-icon-names";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  bb: { branding: { icon: string; experimental_icons: Record<string, string> } };
};
const pluginId = manifest.name.split("/").pop()?.replace(/^bb-plugin-/, "") ?? "";
const declared = manifest.bb.branding.experimental_icons;

const sources = [
  "app.tsx",
  ...readdirSync(join(root, "app"))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => join("app", name)),
];

/** Literal names in `name="…"` props, `icon: "…"` fields and `? "…" : "…"` choices inside `name={…}`. */
function literalNames(source: string): string[] {
  const direct = [...source.matchAll(/\b(?:name|icon)(?:=|:\s*)"([A-Za-z0-9/-]+)"/g)].map((match) => match[1] ?? "");
  const chosen = [...source.matchAll(/\bname=\{[^}]*\}/g)].flatMap((match) =>
    [...match[0].matchAll(/"([A-Za-z0-9/-]+)"/g)].map((inner) => inner[1] ?? ""),
  );
  return [...direct, ...chosen];
}

function isKnown(name: string): boolean {
  if (BB_ICON_NAMES.includes(name)) return true;
  const [owner, local, ...rest] = name.split("/");
  return rest.length === 0 && owner === pluginId && local !== undefined && declared[local] !== undefined;
}

describe("icon names", () => {
  const used = [...new Set(sources.flatMap((file) => literalNames(readFileSync(join(root, file), "utf8"))))];

  it("finds the names it checks", () => {
    expect(used).toEqual(expect.arrayContaining(["screen-sharing/screen-share", "Spinner", "Eye", "EyeOff", "X"]));
  });

  it.each(used)("%s is a bb built-in or one of this plugin's declared icons", (name) => {
    expect(isKnown(name)).toBe(true);
  });

  it("names a real SVG file for the branding icon and every declared icon", () => {
    for (const path of [manifest.bb.branding.icon, ...Object.values(declared)]) {
      expect(path).toMatch(/^\.\/.*\.svg$/);
      expect(existsSync(join(root, path))).toBe(true);
    }
  });

  it("rejects a name bb does not know", () => {
    expect(isKnown("Monitor")).toBe(false);
    expect(isKnown("other-plugin/screen-share")).toBe(false);
  });
});
