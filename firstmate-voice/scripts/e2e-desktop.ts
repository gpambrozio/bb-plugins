// A live end-to-end run in a dev bb, never the owner's: headless Chromium opens the first mate's thread,
// taps Talk in its header, and speaks `say` clips into a Web Audio stream that stands in for the microphone.
// The voice's words are read from the call's data channel; the first mate's chat from the dev bb's CLI.
//
//   node scripts/e2e-desktop.ts --url http://127.0.0.1:48886 --mate thr_… --bb <a dev-bb CLI wrapper>
//
// It checks, in order: the greeting; an ask that reaches the first mate as the captain's words and whose
// reply is spoken back; a suggestion pressed by voice after a read-back and a "yes"; and a Merge button the
// voice refuses to press. It spends a few minutes of the ChatGPT plan's voice time.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Page } from "playwright-core";

import { headlessChromium } from "./chromium.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:48886" },
    mate: { type: "string" },
    bb: { type: "string" },
    out: { type: "string", default: join(process.env.TMPDIR ?? "/tmp", "fmv-e2e") },
    "skip-ask": { type: "boolean", default: false },
  },
});
const base = new URL(values.url);
if (base.port === "38886" || base.port === "38887") throw new Error("That is the owner's bb. Use a dev bb.");
if (values.mate === undefined || values.bb === undefined) throw new Error("--mate and --bb are required.");
const mate = values.mate;
const devBb = values.bb;
mkdirSync(values.out, { recursive: true });

const PRESSED = "Pressed by the captain through FirstMate voice:";
const SPOKEN = "Spoken by the captain through FirstMate voice:";

function clip(text: string): string {
  const path = join(values.out, "clip.wav");
  execFileSync("say", ["-o", path, "--data-format=LEI16@24000", text]);
  return readFileSync(path).toString("base64");
}

/** What was sent to the first mate (the visible parts), oldest first. */
function mateMessages(): string[] {
  const raw = execFileSync(devBb, ["thread", "log", mate, "--json", "--all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = JSON.parse(raw) as { type?: string; data?: { input?: { type?: string; text?: string; visibility?: string }[] } }[];
  return rows
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => (row.data?.input ?? []).filter((part) => part.type === "text" && part.visibility !== "agent-only").map((part) => part.text ?? "").join("\n"));
}

function mateStatus(): string {
  return /Status:\s*(\S+)/u.exec(execFileSync(devBb, ["thread", "show", mate], { encoding: "utf8" }))?.[1] ?? "?";
}

async function until<T>(what: string, ms: number, check: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out after ${ms / 1000} s waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

type DcEvent = { t: number; type: string; transcript?: string };

async function events(page: Page): Promise<DcEvent[]> {
  return page.evaluate(() => (window as unknown as { __events: DcEvent[] }).__events);
}

async function voiceSaid(page: Page, since: number): Promise<string[]> {
  return (await events(page)).filter((event) => event.t > since && event.type === "response.output_audio_transcript.done").map((event) => event.transcript ?? "");
}

/** Waits until the voice has stopped speaking for a moment. */
async function quiet(page: Page, ms = 60_000): Promise<void> {
  await until("the voice to finish", ms, async () => {
    const list = await events(page);
    const last = [...list].reverse().find((event) => event.type.startsWith("output_audio_buffer.") || event.type === "response.created");
    return last === undefined || ((last.type === "output_audio_buffer.stopped" || last.type === "output_audio_buffer.cleared") && Date.now() - last.t > 1_200);
  });
}

async function speak(page: Page, text: string): Promise<number> {
  const at = Date.now();
  const seconds = await page.evaluate((audio) => (window as unknown as { __speak(b64: string): Promise<number> }).__speak(audio), clip(text));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 300));
  console.log(`captain said: ${text}`);
  return at;
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
let pageRef: Page | null = null;
const browser = await chromium.launch({ executablePath: headlessChromium(), args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(() => {
    const audio = new AudioContext({ sampleRate: 48_000 });
    const destination = audio.createMediaStreamDestination();
    // A real microphone always hears a little room noise; without it the track can go quiet and the
    // voice's turn detection never hears the speech end.
    const noise = audio.createBuffer(1, 48_000, 48_000);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * 0.002;
    const floor = audio.createBufferSource();
    floor.buffer = noise;
    floor.loop = true;
    floor.connect(destination);
    floor.start();
    void audio.resume();
    const w = window as unknown as Record<string, unknown>;
    w.__events = [];
    navigator.mediaDevices.getUserMedia = async () => destination.stream;
    w.__speak = async (b64: string) => {
      await audio.resume();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const buffer = await audio.decodeAudioData(bytes.buffer);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
      return buffer.duration;
    };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: Parameters<typeof create>) {
      const channel = create.apply(this, args);
      channel.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(String(message.data)) as { type: string; transcript?: string };
          (w.__events as unknown[]).push({ t: Date.now(), type: event.type, transcript: event.transcript });
        } catch {
          // not JSON
        }
      });
      return channel;
    };
  });
  const page = await context.newPage();
  pageRef = page;
  await page.goto(new URL(`/threads/${mate}`, base).href, { waitUntil: "networkidle" });
  const talk = page.getByRole("button", { name: /^Talk$/u }).first();
  await talk.waitFor({ timeout: 30_000 }).catch(async (error) => {
    await page.screenshot({ path: join(values.out, "no-talk.png") });
    throw error;
  });
  const before = mateMessages().length;
  const t0 = Date.now();
  await talk.click();
  await page.getByText(/FirstMate voice · (Listening|Speaking|Hearing you)/u).waitFor({ timeout: 30_000 });
  report.connectedMs = Date.now() - t0;
  await page.screenshot({ path: join(values.out, "pill.png") });
  await until("the greeting", 30_000, async () => (await voiceSaid(page, t0)).length > 0);
  await quiet(page);
  report.greeting = await voiceSaid(page, t0);
  console.log("greeting:", report.greeting);

  // 1. Ask, and hear the first mate's answer.
  if (!values["skip-ask"]) {
    const asked = await speak(page, "Ask the first mate what two plus two is. It should answer in one word.");
    const askMessage = await until("the ask in the first mate's chat", 30_000, () => mateMessages().slice(before).find((text) => text.startsWith(SPOKEN)));
    report.ask = { message: askMessage, reachedMs: Date.now() - asked };
    console.log("first mate got:", askMessage);
    await until("the first mate's turn", 180_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return mateStatus() === "idle";
    });
    const answered = await until("the spoken answer", 90_000, async () => (await voiceSaid(page, asked)).find((text) => /first mate/iu.test(text) && /\b(four|4)\b/iu.test(text)));
    report.answer = answered;
    console.log("voice said:", answered);
    await quiet(page);
  }

  // 2. Press a suggestion by voice: read-back, then yes.
  const pressAt = await speak(page, "Press the quick status suggestion.");
  const readBack = await until("the read-back", 30_000, async () => (await voiceSaid(page, pressAt)).find((text) => /quick status/iu.test(text)));
  report.readBack = readBack;
  console.log("read-back:", readBack);
  await quiet(page);
  const countBeforeYes = mateMessages().length;
  await speak(page, "Yes.");
  const pressMessage = await until("the press in the first mate's chat", 30_000, () => mateMessages().slice(countBeforeYes).find((text) => text.startsWith(PRESSED)));
  report.press = pressMessage;
  console.log("first mate got:", pressMessage);
  await quiet(page, 120_000);

  // 3. A merge is never pressed by voice.
  const countBeforeMerge = mateMessages().length;
  const mergeAt = await speak(page, "Press merge on the flaky login test.");
  const refusal = await until("the refusal", 30_000, async () => (await voiceSaid(page, mergeAt)).join(" ") || null);
  await quiet(page);
  await speak(page, "Yes.");
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const afterMerge = mateMessages().slice(countBeforeMerge);
  report.merge = { voice: await voiceSaid(page, mergeAt), messagesAfter: afterMerge, merged: afterMerge.some((text) => text.includes("Merge https://github.com/example/web/pull/42")) };
  console.log("voice on merge:", refusal, "| merge sent:", (report.merge as { merged: boolean }).merged);

  await page.getByRole("button", { name: "End", exact: true }).click();
  await page.getByText(/FirstMate voice ·/u).waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  report.endedMs = Date.now() - t0;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.log("FAILED:", report.error);
} finally {
  if (pageRef !== null) {
    report.events = await events(pageRef).catch(() => []);
    // Never leave a call running: End in the pill, if it is still there.
    await pageRef.getByRole("button", { name: "End", exact: true }).click({ timeout: 3_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await browser.close();
}
const out = join(values.out, `e2e-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Report: ${out}`);
