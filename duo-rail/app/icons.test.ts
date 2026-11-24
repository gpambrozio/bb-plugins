/**
 * Every icon name this plugin draws must be one bb knows. An unknown name fails nowhere (bb draws
 * its generic bolt instead), so this is where it fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_BUTTONS, NEW_THREAD_ICON } from "../shared/layout";
import { ACTION_CHOICES, ICON_CHOICES } from "./editor-model";
import { BB_ICON_NAMES } from "./testing/bb-icon-names";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bb: { branding: { icon: string } } };

const sources = [
  "app.tsx",
  ...readdirSync(join(root, "app"), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.") && !name.startsWith("testing"))
    .map((name) => join("app", name)),
];

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

  // The symbols a button can have: what the picker offers, what each action starts with, and the defaults.
  const symbols = [
    ...new Set([
      ...ICON_CHOICES,
      ...ACTION_CHOICES.map((choice) => choice.icon),
      ...DEFAULT_BUTTONS.flatMap((button) => [button.icon, ...(button.action.kind === "menu" ? button.action.items.map((item) => item.icon) : [])]),
    ]),
  ].filter((name) => name !== NEW_THREAD_ICON);

  it.each(symbols)("the button symbol %s is a bb built-in", (name) => {
    expect(BB_ICON_NAMES).toContain(name);
  });

  it("offers every symbol an action starts with", () => {
    for (const choice of ACTION_CHOICES) expect(ICON_CHOICES).toContain(choice.icon);
  });
});
