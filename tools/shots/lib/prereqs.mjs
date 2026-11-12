// The tools a run needs outside npm: a headless Chromium for Playwright, and ffmpeg for video.
// Each lookup prefers what Playwright itself expects and fails with what to do when nothing fits.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Playwright's browser cache: PLAYWRIGHT_BROWSERS_PATH, or its per-OS default. */
export function playwrightCacheDir(env = process.env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
}

/** The revisions the installed playwright-core expects, by browser name. */
export function expectedRevisions() {
  const pkgDir = dirname(require.resolve("playwright-core/package.json"));
  const { browsers } = JSON.parse(readFileSync(join(pkgDir, "browsers.json"), "utf8"));
  return Object.fromEntries(browsers.map((b) => [b.name, b.revision]));
}

const SHELL_BINARIES = {
  "darwin-arm64": "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "darwin-x64": "chrome-headless-shell-mac-x64/chrome-headless-shell",
  "linux-x64": "chrome-headless-shell-linux64/chrome-headless-shell",
  "linux-arm64": "chrome-headless-shell-linux-arm64/chrome-headless-shell",
};

/**
 * Picks the headless Chromium shell: SHOTS_CHROMIUM if set; else the revision playwright-core
 * expects, if cached; else the newest cached revision (close revisions drive the same protocol).
 * Returns { executablePath, note }.
 */
export function findChromium({ env = process.env, cache = playwrightCacheDir(env), expected = expectedRevisions() } = {}) {
  if (env.SHOTS_CHROMIUM) {
    if (!existsSync(env.SHOTS_CHROMIUM)) throw new Error(`SHOTS_CHROMIUM names ${env.SHOTS_CHROMIUM}, which does not exist`);
    return { executablePath: env.SHOTS_CHROMIUM, note: "from SHOTS_CHROMIUM" };
  }
  const binary = SHELL_BINARIES[`${process.platform}-${process.arch}`];
  if (!binary) throw new Error(`no known headless Chromium layout for ${process.platform}-${process.arch}; set SHOTS_CHROMIUM`);
  const want = expected["chromium-headless-shell"];
  const exact = join(cache, `chromium_headless_shell-${want}`, binary);
  if (existsSync(exact)) return { executablePath: exact, note: `revision ${want}` };
  const cached = (existsSync(cache) ? readdirSync(cache) : [])
    .map((name) => /^chromium_headless_shell-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ revision: Number(m[1]), path: join(cache, m[0], binary) }))
    .filter((c) => existsSync(c.path))
    .sort((a, b) => b.revision - a.revision);
  if (cached.length) {
    return { executablePath: cached[0].path, note: `revision ${cached[0].revision} (playwright-core expects ${want})` };
  }
  throw new Error(
    `no headless Chromium in ${cache}. Run \`npx playwright-core install chromium-headless-shell\` in tools/shots, ` +
      "or set SHOTS_CHROMIUM to a chrome-headless-shell binary.",
  );
}

/** The system ffmpeg, which encodes demos and stands in for Playwright's own when that is missing. */
export function findFfmpeg(env = process.env) {
  const candidates = [env.SHOTS_FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      execFileSync(path, ["-hide_banner", "-version"], { stdio: "ignore" });
      return path;
    } catch {}
  }
  try {
    const onPath = execFileSync("/usr/bin/which", ["ffmpeg"], { encoding: "utf8" }).trim();
    if (onPath) return onPath;
  } catch {}
  throw new Error("ffmpeg was not found. Install it (`brew install ffmpeg`) or set SHOTS_FFMPEG; demo videos need it.");
}

/**
 * Playwright records video with its own ffmpeg build, at a revision of its choosing. When the cache
 * lacks that revision, this makes a private browsers folder, under the run's root, whose
 * `ffmpeg-<rev>` points at the system ffmpeg (which must have libvpx; Homebrew's does). Returns the
 * folder to put in PLAYWRIGHT_BROWSERS_PATH before playwright-core is imported, or null when the
 * cache already has it. The shared cache is never written to.
 */
export function videoBrowsersPath({ root, env = process.env, cache = playwrightCacheDir(env), expected = expectedRevisions(), ffmpeg }) {
  const revision = expected.ffmpeg;
  const name = process.platform === "darwin" ? "ffmpeg-mac" : process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux";
  if (existsSync(join(cache, `ffmpeg-${revision}`, name))) return null;
  const dir = join(root, "pw-browsers");
  mkdirSync(join(dir, `ffmpeg-${revision}`), { recursive: true });
  const link = join(dir, `ffmpeg-${revision}`, name);
  if (!existsSync(link)) symlinkSync(ffmpeg, link);
  return dir;
}
