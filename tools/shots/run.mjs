#!/usr/bin/env node
// Screenshots and demo videos of one plugin, from a throwaway dev bb. See README.md.
//
//   node run.mjs <plugin> [--keep] [--out <dir>]
//   node run.mjs --stop          stop a dev bb that --keep (or a killed run) left behind
//
// Starts the dev bb, seeds it, installs <plugin> from its folder, runs <plugin>/shots/shots.mjs and
// copies what it made into <plugin>/docs/screenshots/ (or --out) only when every shot succeeded.
// The dev bb is stopped and its folder removed on success, on failure and on Ctrl+C.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { VARIANTS, Shooter } from "./lib/browser.mjs";
import { DevBb, devBbConfig } from "./lib/devbb.mjs";
import { findChromium, findFfmpeg, videoBrowsersPath } from "./lib/prereqs.mjs";
import { denyList } from "./lib/privacy.mjs";
import { Seeder } from "./lib/seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { keep: { type: "boolean" }, stop: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const usage = "usage: node run.mjs <plugin> [--keep] [--out <dir>] | node run.mjs --stop";
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const devbb = (() => {
  try {
    return new DevBb(devBbConfig());
  } catch (error) {
    fail(error.message);
  }
})();

if (values.stop) {
  await devbb.stop();
  process.exit(0);
}

const [pluginId] = positionals;
if (!pluginId || positionals.length > 1) {
  console.error(usage);
  process.exit(2);
}

const pluginDir = join(REPO, pluginId);
const listFile = join(pluginDir, "shots", "shots.mjs");
if (!existsSync(join(pluginDir, "package.json"))) fail(`${pluginId} is not a plugin folder in ${REPO}`);
if (!existsSync(listFile)) fail(`${pluginId} has no shot list; write ${listFile} (see tools/shots/README.md)`);
const outDir = resolve(values.out ?? join(pluginDir, "docs", "screenshots"));

function fail(message) {
  console.error(`shots: ${message}`);
  process.exit(1);
}

const t0 = Date.now();
const timings = [];
async function phase(name, fn) {
  const start = Date.now();
  const result = await fn();
  timings.push([name, Date.now() - start]);
  return result;
}

// Prerequisites first, so a missing tool fails before anything starts.
const chromiumPath = (() => {
  try {
    const found = findChromium();
    console.log(`chromium: ${found.executablePath} (${found.note})`);
    return found.executablePath;
  } catch (error) {
    fail(error.message);
  }
})();
let ffmpeg = null;
try {
  ffmpeg = findFfmpeg();
} catch (error) {
  console.warn(`warning: ${error.message}`);
}

let shooter = null;
let stopping = null;
async function teardown() {
  stopping ??= (async () => {
    await shooter?.close();
    if (!devbb.started) return; // a dev bb this run did not start (an earlier --keep) is left alone
    if (values.keep) {
      console.log(`--keep: the dev bb is still up at ${devbb.cfg.url}; stop it with \`npm run shots -- --stop\``);
    } else {
      await devbb.stop();
    }
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    console.error(`\n${signal}: stopping the dev bb`);
    teardown().finally(() => process.exit(130));
  });
}

let ok = false;
try {
  await phase("plugin dependencies", () => {
    if (existsSync(join(pluginDir, "node_modules"))) return;
    console.log(`installing ${pluginId}'s dependencies (npm ci)`);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--cache", join(tmpdir(), "bbss-npm-cache")], {
      cwd: pluginDir,
      stdio: "inherit",
    });
  });

  const list = await import(pathToFileURL(listFile).href);
  const version = await phase("dev bb start", () => devbb.start());
  const seed = new Seeder(devbb);
  await phase("seed", async () => {
    seed.renameMachine();
    await seed.scriptedProvider(list.turns ?? []);
    seed.installPlugin(pluginDir);
    await list.seed?.({ bb: devbb, seed });
  });

  // Playwright reads PLAYWRIGHT_BROWSERS_PATH when it loads, so this comes before the import.
  if (ffmpeg) {
    const browsersPath = videoBrowsersPath({ root: devbb.cfg.root, ffmpeg });
    if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
  const { chromium } = await import("playwright-core");
  const staging = join(devbb.cfg.root, "out");
  mkdirSync(staging, { recursive: true });
  shooter = new Shooter({ chromium, executablePath: chromiumPath, url: devbb.cfg.url, out: staging, denyTerms: denyList(), ffmpeg });
  if (!ffmpeg) shooter.video = () => Promise.reject(new Error("this shot list records video, which needs ffmpeg (`brew install ffmpeg`)"));
  await shooter.launch();
  console.log(`shooting ${pluginId} on bb ${version}`);
  await phase("shots", () => list.shoot({ bb: devbb, seed, shots: shooter, VARIANTS }));
  shooter.assertNoSends();

  mkdirSync(outDir, { recursive: true });
  for (const file of shooter.files) copyFileSync(file, join(outDir, basename(file)));
  console.log(`wrote ${shooter.files.length} files to ${outDir}`);
  ok = true;
} catch (error) {
  if (stopping) {
    console.error("shots: interrupted");
  } else {
    console.error(`shots: ${error.stack ?? error.message}`);
  }
  const saved = (await shooter?.failureShots(join(tmpdir(), "bbss-failures")).catch(() => [])) ?? [];
  if (saved.length) console.error(`what the browser showed: ${saved.join(", ")}`);
  if (existsSync(join(devbb.cfg.root, "bb-app.log"))) console.error(`(the dev bb's log is ${join(devbb.cfg.root, "bb-app.log")} until it is removed; pass --keep to keep it)`);
} finally {
  await phase("teardown", teardown);
}

for (const [name, ms] of timings) console.log(`${name.padEnd(22, ".")} ${(ms / 1000).toFixed(1)} s`);
console.log(`${"total".padEnd(22, ".")} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
