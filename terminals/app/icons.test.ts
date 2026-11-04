/**
 * Every icon name this plugin draws must be one bb knows. An unknown name
 * fails nowhere — bb draws its generic bolt instead — so this is where it fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BB_ICON_NAMES } from "./testing/bb-icon-names";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bb: { branding: { icon: string } } };

const sources = [
  "app.tsx",
  ...readdirSync(join(root, "app"), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts"))
    .map((name) => join("app", name)),
];

/** Literal names in `name="…"` props, `name={x ? "…" : "…"}` and `icon: "…"` fields. */
function literalNames(source: string): string[] {
  const direct = [...source.matchAll(/\b(?:name|icon)(?:=|:\s*)"([A-Za-z0-9/-]+)"/g)].map((match) => match[1] ?? "");
  const ternary = [...source.matchAll(/\bname=\{[^}]*\?\s*"([A-Za-z0-9-]+)"\s*:\s*"([A-Za-z0-9-]+)"\s*\}/g)].flatMap((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]);
  return [...direct, ...ternary];
}

describe("icon names", () => {
  const used = [
    ...new Set([manifest.bb.branding.icon, ...sources.flatMap((file) => literalNames(readFileSync(join(root, file), "utf8")))]),
  ];

  it("finds the names it checks", () => {
    expect(used).toEqual(expect.arrayContaining(["Terminal", "Plus", "Spinner", "X", "Laptop", "ChevronLeft", "ChevronRight"]));
  });

  it.each(used)("%s is a bb built-in", (name) => {
    expect(BB_ICON_NAMES).toContain(name);
  });
});
