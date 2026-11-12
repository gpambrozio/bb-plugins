// Playwright against the dev bb's web app: pages per variant, stills, element crops and demo videos.
// Every page is guarded: a request that would send a message or start a thread from the browser is
// refused and fails the run, so a shot list cannot reach a real provider even by a stray Enter.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { assertPagePrivate } from "./privacy.mjs";

/** API calls that would hand a prompt to an agent. Threads come from the seed, never the browser. */
export const SEND_ROUTES = /\/api\/v1\/threads(?:\/fork|\/[^/?]+\/(?:send|edit-message|retry|queued-messages(?:\/[^?]*)?))?(?:\?.*)?$/;

/** Common variants. Phone pages are drawn at 3×, the rest at 2×. */
export const VARIANTS = {
  desktopLight: { name: "desktop-light", colorScheme: "light", viewport: { width: 1280, height: 800 } },
  desktopDark: { name: "desktop-dark", colorScheme: "dark", viewport: { width: 1280, height: 800 } },
  phoneLight: { name: "phone-light", colorScheme: "light", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  phoneDark: { name: "phone-dark", colorScheme: "dark", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

export class Shooter {
  constructor({ chromium, executablePath, url, out, denyTerms, ffmpeg, log = console.log }) {
    Object.assign(this, { chromium, executablePath, url, out, denyTerms, ffmpeg, log });
    this.browser = null;
    this.contexts = new Set();
    this.files = [];
    this.violations = [];
  }

  async launch() {
    // Playwright's own signal handlers exit at once; run.mjs handles signals so it can stop the dev bb.
    this.browser = await this.chromium.launch({
      headless: true,
      executablePath: this.executablePath,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  }

  async close() {
    for (const context of this.contexts) await context.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  /**
   * A fresh browser context and page on the dev bb, past its first-run screen. `variant` takes
   * Playwright context options (colorScheme, viewport, isMobile, hasTouch, deviceScaleFactor, recordVideo).
   */
  async page(variant = VARIANTS.desktopLight, path = "/") {
    const { name, ...options } = variant;
    const context = await this.browser.newContext({ deviceScaleFactor: options.isMobile ? 3 : 2, ...options });
    this.contexts.add(context);
    await context.route(SEND_ROUTES, (route) => {
      if (route.request().method() === "GET") return route.continue();
      const what = `${route.request().method()} ${new URL(route.request().url()).pathname}`;
      this.violations.push(what);
      this.log(`refused ${what}: shot lists must not send messages or start threads from the browser`);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(new URL(path, this.url).href, { waitUntil: "networkidle" });
    const skip = page.getByRole("button", { name: "Skip setup" });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    return page;
  }

  async closePage(page) {
    const context = page.context();
    this.contexts.delete(context);
    await context.close();
  }

  /** Saves every open page as `<dir>/failure-<n>.png`, for a run that failed. Not privacy-gated: local only. */
  async failureShots(dir) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const context of this.contexts) {
      for (const page of context.pages()) {
        const path = join(dir, `failure-${saved.length + 1}.png`);
        if (await page.screenshot({ path }).then(() => true, () => false)) saved.push(path);
      }
    }
    return saved;
  }

  assertNoSends() {
    if (this.violations.length) throw new Error(`the shot list tried to send from the browser: ${this.violations.join(", ")}`);
  }

  /**
   * Saves a still to `<out>/<file>`. With `around` (locators), crops to their union plus `pad`
   * pixels; with `clip`, to that box; otherwise the viewport. The privacy gate runs first.
   */
  async still(page, file, { around, clip, pad = 24 } = {}) {
    this.assertNoSends();
    await assertPagePrivate(page, this.denyTerms, file);
    if (around) clip = await unionBox(page, around, pad);
    const path = join(this.out, file);
    await page.screenshot({ path, clip, animations: "disabled" });
    this.files.push(path);
    this.log(`  ${file}`);
    return path;
  }

  /**
   * Records `act(page)` and writes `<base>.gif` (`gifWidth` px wide, `fps`) and/or `<base>.mp4`, as
   * `formats` asks. The privacy gate samples the page while it records.
   */
  async video(base, variant, act, { formats = ["gif", "mp4"], gifWidth = 960, fps = 12 } = {}) {
    const dir = join(this.out, `.video-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const size = variant.viewport;
    const page = await this.page({ ...variant, deviceScaleFactor: 1, recordVideo: { dir, size } });
    const failures = [];
    const sampler = setInterval(() => {
      assertPagePrivate(page, this.denyTerms, `${base} (video)`).catch((e) => failures.push(e));
    }, 500);
    try {
      await act(page);
      await assertPagePrivate(page, this.denyTerms, `${base} (video)`);
    } finally {
      clearInterval(sampler);
    }
    const video = page.video();
    await this.closePage(page);
    if (failures.length && !/Target .*closed|has been closed/.test(failures[0].message)) throw failures[0];
    this.assertNoSends();
    const webm = join(dir, `${base}.webm`);
    await video.saveAs(webm);
    const ff = (...args) => execFileSync(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
    const written = [];
    if (formats.includes("mp4")) {
      written.push(join(this.out, `${base}.mp4`));
      ff("-i", webm, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", written.at(-1));
    }
    if (formats.includes("gif")) {
      written.push(join(this.out, `${base}.gif`));
      const palette = "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4";
      ff("-i", webm, "-vf", `fps=${fps},scale=${gifWidth}:-1:flags=lanczos,${palette}`, written.at(-1));
    }
    rmSync(dir, { recursive: true, force: true });
    this.files.push(...written);
    this.log(`  ${written.map((path) => basename(path)).join(", ")}`);
  }
}

/** The smallest box holding every visible locator, grown by `pad` and kept inside the viewport. */
export async function unionBox(page, locators, pad) {
  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (box) boxes.push(box);
  }
  if (!boxes.length) throw new Error("none of the elements to crop around is visible");
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

