// The newest headless Chromium in Playwright's cache (the one tools/shots uses), or $SPIKE_CHROMIUM.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function headlessChromium(): string {
  if (process.env.SPIKE_CHROMIUM) return process.env.SPIKE_CHROMIUM;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .map((name) => /^chromium_headless_shell-(\d+)$/u.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ revision: Number(match[1]), path: join(cache, match[0], "chrome-headless-shell-mac-arm64", "chrome-headless-shell") }))
    .filter((candidate) => existsSync(candidate.path))
    .sort((a, b) => b.revision - a.revision);
  if (!found[0]) throw new Error(`No headless Chromium in ${cache}; set SPIKE_CHROMIUM.`);
  return found[0].path;
}
