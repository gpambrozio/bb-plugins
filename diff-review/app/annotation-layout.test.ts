/**
 * The comment boxes' layout in a real browser, with the real `@pierre/diffs`: jsdom has no layout,
 * and the app tests stand in for Pierre. A comment with a long word and a long code block must fit
 * the visible pane, in unified and split views, and never make the code scroll sideways.
 *
 * It needs a Chromium: `CHROME_PATH`, a Playwright download, or an installed Chrome (GitHub's Ubuntu
 * runners have one). Without one it is skipped, except in CI, where it fails.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ANNOTATION_FIT } from "./annotation-fit";

/** The CSS bb's Tailwind makes of each class in `ANNOTATION_FIT`; a class missing here fails the test. */
const CLASS_CSS: Record<string, string> = {
  "[contain:inline-size]": "contain: inline-size;",
  "[overflow-wrap:anywhere]": "overflow-wrap: anywhere;",
  "[&_pre]:overflow-x-auto": "& pre { overflow-x: auto; }",
};

function findChromium(): string | null {
  const candidates = [process.env.CHROME_PATH ?? ""];
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(
        join(cache, entry, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(cache, entry, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
        join(cache, entry, "chrome-linux64/chrome"),
        join(cache, entry, "chrome-linux/chrome"),
      );
    }
  }
  candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  return candidates.find((path) => path !== "" && existsSync(path)) ?? null;
}

const executablePath = findChromium();
if (executablePath === null && process.env.CI) throw new Error("No Chromium for the browser layout test: set CHROME_PATH.");

interface Layout {
  /** Each code scroller's scroll width and visible width. */
  scrollers: [number, number][];
  paneRight: number;
  cardRight: number;
  preRight: number;
  preScrolls: boolean;
}

describe.skipIf(executablePath === null)("comment boxes in the real diff", () => {
  let dir: string;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "diff-review-layout-"));
    await build({
      entryPoints: [fileURLToPath(new URL("./testing/annotation-layout-page.tsx", import.meta.url))],
      bundle: true,
      outfile: join(dir, "page.js"),
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
    });
    const css = ANNOTATION_FIT.split(" ")
      .map((name) => {
        const rule = CLASS_CSS[name];
        if (rule === undefined) throw new Error(`No CSS for ${name}: add it to CLASS_CSS.`);
        return `.${name.replace(/[^\w-]/g, "\\$&")} { ${rule} }`;
      })
      .join("\n");
    writeFileSync(join(dir, "page.html"), `<!doctype html><style>body { margin: 8px; font-family: sans-serif; }\n${css}</style><div id="root"></div><script src="page.js"></script>`);
    browser = await chromium.launch({ executablePath: executablePath! });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function layout(style: "unified" | "split", fit: boolean): Promise<Layout> {
    await page.goto(`${pathToFileURL(join(dir, "page.html")).href}?style=${style}&fit=${fit ? 1 : 0}`);
    await page.waitForSelector("[data-card] pre");
    // Pierre highlights and measures after mounting; wait for its layout to settle.
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const host = Array.from(document.querySelectorAll("*")).find((element) => element.shadowRoot !== null)!;
      const scrollers = Array.from(host.shadowRoot!.querySelectorAll<HTMLElement>("[data-code]")).map((code) => [code.scrollWidth, code.clientWidth] as [number, number]);
      const pre = document.querySelector<HTMLElement>("[data-card] pre")!;
      return {
        scrollers,
        paneRight: document.querySelector("[data-pane]")!.getBoundingClientRect().right,
        cardRight: document.querySelector("[data-card]")!.getBoundingClientRect().right,
        preRight: pre.getBoundingClientRect().right,
        preScrolls: pre.scrollWidth > pre.clientWidth,
      };
    });
  }

  for (const style of ["unified", "split"] as const) {
    it(`fits the pane in the ${style} view, wrapping the text and scrolling the code block inside the card`, async () => {
      const { scrollers, paneRight, cardRight, preRight, preScrolls } = await layout(style, true);
      expect(cardRight).toBeLessThanOrEqual(paneRight);
      expect(preRight).toBeLessThanOrEqual(cardRight);
      expect(preScrolls).toBe(true);
      for (const [scrollWidth, clientWidth] of scrollers) expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    it(`overflows the pane in the ${style} view without the box, so the check above means something`, async () => {
      const { paneRight, cardRight } = await layout(style, false);
      expect(cardRight).toBeGreaterThan(paneRight);
    });
  }
});
