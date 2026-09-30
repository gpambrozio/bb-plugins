import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TEMPLATE_FILES } from "./templates.generated";
import { TEMPLATES, fill, message, readTemplate, withoutNotes, type TemplatePath } from "./templates";

const templatesRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

describe("templates/", () => {
  it("TEMPLATES names exactly the files in templates/", () => {
    expect(filesUnder(templatesRoot)).toEqual(Object.values(TEMPLATES).sort());
  });

  it("the generated module matches templates/ byte for byte", async () => {
    for (const path of Object.values(TEMPLATES)) {
      expect(await readTemplate(path), path).toBe(readFileSync(join(templatesRoot, path), "utf8"));
    }
  });

  it("the generated module has exactly the files in templates/, so a stale key fails", () => {
    expect(Object.keys(TEMPLATE_FILES).sort()).toEqual(filesUnder(templatesRoot));
  });

  it("package.json ships templates/", () => {
    const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { files: string[] };
    expect(manifest.files).toContain("templates/");
  });

  it("readTemplate rejects a path it does not have", async () => {
    await expect(readTemplate("nope.md" as TemplatePath)).rejects.toThrow("Unknown template nope.md");
  });
});

describe("withoutNotes and fill", () => {
  it("leave out the notes, then fill only the names given", () => {
    const template = "<!-- where this goes -->\n\nHome: {{home}}, crew: {{crew}}.\r\n<!-- another -->";
    expect(fill(withoutNotes(template), { home: "/h" })).toBe("Home: /h, crew: {{crew}}.");
  });

  it("fills in a single pass, so a value naming a placeholder arrives as written", () => {
    expect(fill("{{a}} and {{b}}", { a: "{{b}}", b: "B" })).toBe("{{b}} and B");
    expect(fill("{{title}}", { title: "{{title}}" })).toBe("{{title}}");
  });

  it("message drops the notes and fills the placeholders", async () => {
    const text = await message(TEMPLATES.restartNote, {});
    expect(text).not.toContain("<!--");
  });
});
