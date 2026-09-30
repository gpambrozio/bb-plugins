import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STATE_DIR } from "../shared/types";
import { isHomeReady, parseProjects, prepareHome, readBacklog, readOpening, type HomeConfig } from "./home";
import { TEMPLATES, readTemplate, withoutNotes } from "./templates";

const homeConfig = (overrides: Partial<HomeConfig> = {}): HomeConfig => ({ crewProvider: "", crewReasoning: "", ...overrides });
const HOME_ICON_FILE = TEMPLATES.icon;
const defaultOpening = async () => withoutNotes(await readTemplate(TEMPLATES.opening));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-home-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareHome", () => {
  it("writes the charter and every record, and a relaunch rewrites only the charter", async () => {
    const home = await tempHome();
    expect(await isHomeReady(home)).toBe(false);

    await prepareHome(home, homeConfig({}));
    expect(await isHomeReady(home)).toBe(true);
    expect(await readBacklog(home)).toEqual([]);

    await writeFile(join(home, "data", "captain.md"), "- Always use pnpm.\n", "utf8");
    await writeFile(join(home, "AGENTS.md"), "stale", "utf8");
    await prepareHome(home, homeConfig({ crewProvider: "codex/gpt-5.5" }));

    expect(await readFile(join(home, "data", "captain.md"), "utf8")).toBe("- Always use pnpm.\n");
    const charter = await readFile(join(home, "AGENTS.md"), "utf8");
    expect(charter).toContain("`codex/gpt-5.5`");
    expect(charter).toContain(home);
  });

  it("creates .firstmate/ in a new home", async () => {
    const home = await tempHome();
    await prepareHome(home, homeConfig());
    expect((await stat(join(home, STATE_DIR))).isDirectory()).toBe(true);
  });

  it("puts an icon where Paseo looks for one, and keeps one the captain replaced it with", async () => {
    const home = await tempHome();
    await prepareHome(home, homeConfig({}));
    const icon = await readFile(join(home, HOME_ICON_FILE), "utf8");
    // What Paseo takes from a project's folder: 32 KB at most, square — an SVG is taken as square.
    expect(Buffer.byteLength(icon)).toBeLessThan(32 * 1024);
    expect(icon).toContain('viewBox="0 0 128 128"');

    await writeFile(join(home, HOME_ICON_FILE), "<svg/>", "utf8");
    await prepareHome(home, homeConfig({}));
    expect(await readFile(join(home, HOME_ICON_FILE), "utf8")).toBe("<svg/>");
  });
});

describe("readOpening", () => {
  it("starts as the plugin's own opening, and keeps the captain's once written", async () => {
    const home = await tempHome();
    expect(await readOpening(home)).toBe(await defaultOpening());

    await prepareHome(home, homeConfig({}));
    const written = await readFile(join(home, "data", "opening.md"), "utf8");
    expect(written).toMatch(/^<!--/);
    expect(await readOpening(home)).toBe(await defaultOpening());

    await writeFile(join(home, "data", "opening.md"), "Ahoy!\n<!-- in Portuguese next time -->\nTake the helm.\n", "utf8");
    await prepareHome(home, homeConfig({}));
    expect(await readOpening(home)).toBe("Ahoy!\n\nTake the helm.");
  });

  it("falls back to the plugin's own opening when the file says nothing but notes", async () => {
    const home = await tempHome();
    await prepareHome(home, homeConfig({}));
    await writeFile(join(home, "data", "opening.md"), "<!-- nothing to say -->\n\n", "utf8");
    expect(await readOpening(home)).toBe(await defaultOpening());
  });
});

describe("parseProjects", () => {
  it("reads the registry lines and skips the prose around them", () => {
    const projects = parseProjects(`# Projects

One line per project: \`- <name> [<mode> +yolo] - <path or clone URL> - <description>\`.

- web [direct-PR +yolo] - /Users/me/code/web - The storefront
- api [local-only] - /Users/me/code/api
- docs - https://github.com/me/docs - Written by hand
- site - ~/src/site - see [the docs](https://x) [WIP]
- One line of prose that is not a project.
`);
    expect(projects).toEqual([
      { name: "web", mode: "direct-PR", yolo: true, location: "/Users/me/code/web", description: "The storefront" },
      { name: "api", mode: "local-only", yolo: false, location: "/Users/me/code/api", description: null },
      { name: "docs", mode: null, yolo: false, location: "https://github.com/me/docs", description: "Written by hand" },
      { name: "site", mode: null, yolo: false, location: "~/src/site", description: "see [the docs](https://x) [WIP]" },
    ]);
  });
});
