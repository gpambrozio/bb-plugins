// Phase 0, desktop: drives the spike page in a dev bb with headless Chromium
// (Electron's engine), with a spoken clip as the microphone, and saves what
// the page measured. Never point it at the owner's bb.
//
//   npm run desktop-check -- --url http://127.0.0.1:48886 [--runs webrtc,relay] [--effort low] [--model gpt-realtime-2.1]
//
// The clip (macOS `say`): 3 s of silence, "Say hello in three words.", 7 s of
// silence, "What time is it right now?" (the server answers the get_time tool),
// then silence. Each run lasts 26 s and the page hangs up by itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright-core";

import { headlessChromium } from "./chromium.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:48886" },
    runs: { type: "string", default: "webrtc,relay" },
    effort: { type: "string", default: "low" },
    model: { type: "string", default: "gpt-realtime-2.1" },
    seconds: { type: "string", default: "26" },
    announceAt: { type: "string", default: "21" },
    out: { type: "string", default: join(process.env.TMPDIR ?? "/tmp", "fmv") },
  },
});
const allowed = new URL(values.url);
if (allowed.port === "38886" || allowed.port === "38887") throw new Error("That is the owner's bb. Use a dev bb.");

const RATE = 48_000;

function pcm(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function spoken(text: string): Buffer {
  const path = join(values.out, "phrase.wav");
  execFileSync("say", ["-o", path, `--data-format=LEI16@${RATE}`, text]);
  return pcm(readFileSync(path));
}

function wav(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const silence = (seconds: number) => Buffer.alloc(Math.round(RATE * seconds) * 2);

mkdirSync(values.out, { recursive: true });
const clipPath = join(values.out, "clip.wav");
const first = spoken("Say hello in three words.");
const second = spoken("What time is it right now?");
writeFileSync(clipPath, wav(Buffer.concat([silence(3), first, silence(7), second, silence(14)])));
console.log(`Clip: ${clipPath} (question one at 3.0 s, ends ${(3 + first.length / 2 / RATE).toFixed(1)} s; question two at ${(10 + first.length / 2 / RATE).toFixed(1)} s)`);

const browser = await chromium.launch({
  executablePath: headlessChromium(),
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${clipPath}%noloop`],
});
const results: unknown[] = [];
try {
  const page = await browser.newPage();
  const spike = new URL("/plugins/firstmate-voice/spike", values.url).toString();
  await page.goto(spike, { waitUntil: "networkidle" });
  // A fresh dev bb opens on its setup steps (agent, projects, plugins,
  // devices). Step through them with Skip / Continue only; nothing is installed.
  const talk = page.getByRole("button", { name: "Talk: WebRTC" });
  for (let step = 0; step < 8; step += 1) {
    const next = page.getByRole("button", { name: /^(skip setup|skip|continue|not now|finish|done|get started)/i }).first();
    await talk.or(next).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (await talk.isVisible().catch(() => false)) break;
    // The projects step pre-selects recent repositories: deselect them all, import nothing.
    const importing = page.getByRole("button", { name: /^Import [1-9]\d* projects?/ });
    for (let tries = 0; tries < 3 && (await importing.isVisible().catch(() => false)); tries += 1) {
      await page.getByText("Select all").click();
      await page.waitForTimeout(300);
    }
    if (await next.isVisible().catch(() => false)) {
      console.log(`Setup: ${(await next.innerText()).trim()}`);
      await next.click();
      await page.waitForTimeout(1_000);
    } else {
      await page.goto(spike, { waitUntil: "networkidle" });
    }
  }
  await talk.waitFor({ timeout: 30_000 }).catch(async (error) => {
    await page.screenshot({ path: join(values.out, "desktop-check-failure.png") });
    throw error;
  });
  await page.locator("select").nth(0).selectOption(values.model);
  await page.locator("select").nth(1).selectOption(values.effort);
  await page.locator('input[type="number"]').fill(values.seconds);

  for (const run of values.runs.split(",")) {
    const button = run === "webrtc" ? "Talk: WebRTC" : "Talk: relayed";
    const before = Date.now();
    await page.getByRole("button", { name: button }).click();
    if (run === "webrtc" && Number(values.announceAt) > 0) {
      await page.waitForTimeout(Number(values.announceAt) * 1000);
      await page.getByRole("button", { name: "Announce" }).click().catch(() => console.log("Announce was not available."));
    }
    await page.waitForFunction(() => window.__firstmateVoiceSpike && !window.__firstmateVoiceSpike.running, null, { timeout: (Number(values.seconds) + 40) * 1000 });
    const state = await page.evaluate(() => window.__firstmateVoiceSpike);
    const result = (state?.results ?? []).at(-1);
    results.push(result);
    console.log(`${run}: finished in ${((Date.now() - before) / 1000).toFixed(1)} s, saved ${state?.saved}`);
  }
} finally {
  await browser.close();
}

const out = join(values.out, `desktop-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`Results: ${out}`);
for (const result of results as Record<string, Record<string, unknown>>[]) {
  for (const path of ["webrtc", "relay"]) {
    const run = result?.[path];
    if (!run) continue;
    console.log(path, JSON.stringify({ timings: run.timings, turns: run.turns, serverToReply: run.serverToReply, onsets: run.onsets, peaks: run.peaks, remoteAudioElement: run.remoteAudioElement, error: run.error }));
  }
}
