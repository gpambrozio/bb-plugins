/**
 * Every icon name this plugin draws must be one bb knows. An unknown name fails nowhere (bb draws
 * its generic bolt instead), so this is where it fails. The list is generated from bb's app bundle
 * (scripts/icon-names.mjs); these checks hold it to what the plugin needs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_BUTTONS, NEW_THREAD_ICON } from "../shared/layout";
import { ACTION_CHOICES, ICON_CHOICES } from "./editor-model";
import { BB_ICON_NAMES, BB_ICON_NAMES_SOURCE } from "./icon-names";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bb: { branding: { icon: string } } };

const sources = [
  "app.tsx",
  ...readdirSync(join(root, "app"), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.") && !name.startsWith("testing"))
    .map((name) => join("app", name)),
];

describe("bb's icon list", () => {
  it("names each icon once", () => {
    expect(new Set(BB_ICON_NAMES).size).toBe(BB_ICON_NAMES.length);
  });

  it("is bb's whole set, read from a named bb version", () => {
    // bb 0.49 and 0.50.1 both have 180: 55 bundled eagerly, 125 loaded on first use.
    expect(BB_ICON_NAMES.length).toBeGreaterThanOrEqual(180);
    expect(BB_ICON_NAMES_SOURCE).toMatch(/^bb \d+\.\d+\.\d+$/);
    expect(BB_ICON_NAMES).toEqual(expect.arrayContaining(["AlertCircle", "Zap", "AiBrain01", "ZoomOut"]));
  });

  it("holds only plain icon names, never bb's New thread glyph", () => {
    for (const name of BB_ICON_NAMES) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
});

describe("icon names", () => {
  const used = [
    ...new Set([manifest.bb.branding.icon, ...sources.flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/\bname="([A-Za-z0-9-]+)"/g)].map((match) => match[1] ?? ""))]),
  ];

  it("finds the names it checks", () => {
    expect(used).toEqual(expect.arrayContaining(["Smartphone", "ArrowUp", "ArrowDown", "Edit", "Trash2", "Plus"]));
  });

  it.each(used)("%s is a bb built-in", (name) => {
    expect(BB_ICON_NAMES).toContain(name);
  });

  // The symbols a button starts with: what each action starts with, and the defaults. The picker's own
  // list is bb's (above).
  const symbols = [
    ...new Set([
      ...ACTION_CHOICES.map((choice) => choice.icon),
      ...DEFAULT_BUTTONS.flatMap((button) => [button.icon, ...(button.action.kind === "menu" ? button.action.items.map((item) => item.icon) : [])]),
    ]),
  ].filter((name) => name !== NEW_THREAD_ICON);

  it.each(symbols)("the button symbol %s is a bb built-in", (name) => {
    expect(BB_ICON_NAMES).toContain(name);
  });

  it("offers every symbol an action starts with and the default buttons use, New thread first", () => {
    expect(ICON_CHOICES[0]).toBe(NEW_THREAD_ICON);
    for (const name of [NEW_THREAD_ICON, ...symbols]) expect(ICON_CHOICES).toContain(name);
    expect(new Set(ICON_CHOICES).size).toBe(ICON_CHOICES.length);
  });
});
