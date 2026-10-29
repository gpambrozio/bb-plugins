/**
 * The comment boxes' layout in a real browser, with the real `@pierre/diffs`: jsdom has no layout,
 * and the app tests stand in for Pierre. A comment with a long word and a long code block must fit
 * the visible pane, in unified and split views, and never make the code scroll sideways. Scrolling to
 * a place must move the tab's own scroll area only, never bb's containers around it.
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
  /** The previous/next comment arrows' box, against the card's top. */
  arrowsRight: number;
  arrowsTop: number;
  cardTop: number;
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
    await build({
      entryPoints: [fileURLToPath(new URL("./testing/scroll-page.ts", import.meta.url))],
      bundle: true,
      outfile: join(dir, "scroll.js"),
      logLevel: "error",
    });
    writeFileSync(join(dir, "scroll.html"), `<!doctype html><body style="margin: 0"><script src="scroll.js"></script></body>`);
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
        arrowsRight: document.querySelector("[data-arrows]")!.getBoundingClientRect().right,
        arrowsTop: document.querySelector("[data-arrows]")!.getBoundingClientRect().top,
        cardTop: document.querySelector("[data-card]")!.getBoundingClientRect().top,
      };
    });
  }

  /** Scrolls to the last file one way or the other; where bb's container, the toolbar and the tab's area end up. */
  async function scrollToLastFile(how: "scrollIntoView" | "scrollWithin") {
    await page.goto(pathToFileURL(join(dir, "scroll.html")).href);
    await page.waitForSelector("[data-scroll] section");
    return page.evaluate((how) => {
      const root = document.querySelector<HTMLElement>("[data-scroll]")!;
      const last = Array.from(root.querySelectorAll("section")).at(-1)!;
      if (how === "scrollIntoView") last.scrollIntoView({ block: "start" });
      else window.scrollWithin(root, last, "start");
      const bb = document.querySelector<HTMLElement>("[data-bb]")!;
      return {
        bbScrollTop: bb.scrollTop,
        toolbarTop: document.querySelector("[data-toolbar]")!.getBoundingClientRect().top - bb.getBoundingClientRect().top,
        rootScrollTop: root.scrollTop,
        rootMax: root.scrollHeight - root.clientHeight,
      };
    }, how);
  }

  it("scrolls only the tab's own area to a file, so the toolbar stays in sight", async () => {
    const { bbScrollTop, toolbarTop, rootScrollTop, rootMax } = await scrollToLastFile("scrollWithin");
    expect(bbScrollTop).toBe(0);
    expect(toolbarTop).toBe(32);
    expect(rootScrollTop).toBe(rootMax);
  });

  it("would scroll bb's clipping container with scrollIntoView, hiding the toolbar, so the check above means something", async () => {
    const { bbScrollTop, toolbarTop } = await scrollToLastFile("scrollIntoView");
    expect(bbScrollTop).toBeGreaterThan(0);
    expect(toolbarTop).toBeLessThan(32);
  });

  /**
   * Lands on the comment in file 6 with file 5 still partly in view above it, then draws file 5's
   * diff 800px tall a little later, as a lazily loaded file does. Where the comment is against the
   * top of the tab's area, before and after.
   */
  async function landThenExpandAbove(how: "scrollWithin" | "scrollTop", { wheel = false } = {}) {
    await page.goto(pathToFileURL(join(dir, "scroll.html")).href);
    await page.waitForSelector("[data-card]");
    const before = await page.evaluate((how) => {
      const root = document.querySelector<HTMLElement>("[data-scroll]")!;
      const card = document.querySelector<HTMLElement>("[data-card]")!;
      const above = document.querySelector<HTMLElement>('[data-file="5"]')!;
      // File 5's last 60px at the top, the comment under it.
      const place = above.getBoundingClientRect().bottom - root.getBoundingClientRect().top - 60;
      if (how === "scrollWithin") {
        root.scrollTop += place;
        window.scrollWithin(root, card, "nearest");
      } else root.scrollTop += place;
      return card.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }, how);
    if (wheel) {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 1);
    }
    await page.waitForTimeout(300);
    await page.evaluate(() => window.expand(5, 800));
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelector("[data-card]")!.getBoundingClientRect().top - document.querySelector("[data-scroll]")!.getBoundingClientRect().top);
    return { before, after };
  }

  it("keeps a comment it scrolled to in place while a file above it draws its diff", async () => {
    const { before, after } = await landThenExpandAbove("scrollWithin");
    expect(before).toBeGreaterThan(0);
    // In full view: the tab's area is 328px tall, the comment 60px.
    expect(before + 60).toBeLessThanOrEqual(328);
    expect(Math.abs(after - before)).toBeLessThan(1);
  });

  it("would let the file above push the comment out of view, so the check above means something", async () => {
    const { before, after } = await landThenExpandAbove("scrollTop");
    // File 5's body grows from 135px to 800px: the comment goes down as far, out of the 328px view.
    expect(after - before).toBeGreaterThan(600);
  });

  it("lets go of the comment once the user scrolls", async () => {
    const { before, after } = await landThenExpandAbove("scrollWithin", { wheel: true });
    expect(after - before).toBeGreaterThan(600);
  });

  for (const style of ["unified", "split"] as const) {
    it(`fits the pane in the ${style} view, wrapping the text and scrolling the code block inside the card`, async () => {
      const { scrollers, paneRight, cardRight, preRight, preScrolls } = await layout(style, true);
      expect(cardRight).toBeLessThanOrEqual(paneRight);
      expect(preRight).toBeLessThanOrEqual(cardRight);
      expect(preScrolls).toBe(true);
      for (const [scrollWidth, clientWidth] of scrollers) expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    it(`keeps the previous/next arrows at the card's top right, past a long path, in the ${style} view`, async () => {
      const { cardRight, cardTop, arrowsRight, arrowsTop } = await layout(style, true);
      expect(arrowsRight).toBeLessThanOrEqual(cardRight);
      expect(arrowsRight).toBeGreaterThan(cardRight - 40);
      expect(arrowsTop - cardTop).toBeLessThan(24);
    });

    it(`overflows the pane in the ${style} view without the box, so the check above means something`, async () => {
      const { paneRight, cardRight } = await layout(style, false);
      expect(cardRight).toBeGreaterThan(paneRight);
    });
  }
});
