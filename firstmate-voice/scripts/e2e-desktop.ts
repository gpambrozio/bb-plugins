// A live end-to-end run in a dev bb, never the owner's: headless Chromium opens the first mate's thread,
// taps Talk in its header, and speaks `say` clips into a Web Audio stream that stands in for the microphone.
// The voice's words are read from the call's data channel; the first mate's chat from the dev bb's CLI.
//
//   node scripts/e2e-desktop.ts --url http://127.0.0.1:48886 --mate thr_… --bb <a dev-bb CLI wrapper>
//
// With --split-only it checks one thing: a request said in two breaths reaches the first mate whole, with
// the voice's account beside it. Otherwise it checks, in order: the greeting; an ask that reaches the first
// mate as the captain's words and whose reply is spoken back; and a request to press a Merge button, which
// the voice sends to the board without sending any button's prompt. It spends a few minutes of the ChatGPT
// plan's voice time.
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
    /** Only the split ask: one request in two clips with a pause between, then End. */
    "split-only": { type: "boolean", default: false },
  },
});
const base = new URL(values.url);
if (base.port === "38886" || base.port === "38887") throw new Error("That is the owner's bb. Use a dev bb.");
if (values.mate === undefined || values.bb === undefined) throw new Error("--mate and --bb are required.");
const mate = values.mate;
const devBb = values.bb;
mkdirSync(values.out, { recursive: true });

const SPOKEN = "Spoken by the captain through FirstMate voice:";
const ACCOUNT = "The voice assistant's account, in its own words, not the captain's:";

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
/** Ends a run early on purpose; the finally block still ends the call. */
class Done extends Error {}
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

  // 0. One request in two breaths: turn detection ends the turn at the pause, and both halves must still go.
  if (values["split-only"]) {
    // As the captain's request split: the first breath sounds unfinished, then a short pause.
    const splitAt = await speak(page, "Ask the first mate to reply with the word apple, and then");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await speak(page, "the word banana after it. Nothing else.");
    const message = await until("the split ask in the first mate's chat", 45_000, () => mateMessages().slice(before).find((text) => text.startsWith(SPOKEN)));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    report.spokenMessages = mateMessages().slice(before).filter((text) => text.startsWith(SPOKEN));
    const [words = "", account = ""] = message.slice(SPOKEN.length).split(ACCOUNT).map((part) => part.trim());
    report.split = { message, reachedMs: Date.now() - splitAt, wordsHaveBoth: /apple/iu.test(words) && /banana/iu.test(words), accountHasBoth: /apple/iu.test(account) && /banana/iu.test(account) };
    console.log("first mate got:", message);
    await quiet(page, 90_000);
  }

  // 1. Ask, and hear the first mate's answer.
  if (!values["skip-ask"] && !values["split-only"]) {
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

  if (values["split-only"]) throw new Done();

  // 2. A button is never pressed by voice: the voice sends the captain to the board, and no button's
  // prompt reaches the first mate.
  const countBeforePress = mateMessages().length;
  const pressAt = await speak(page, "Press merge on the flaky login test.");
  const refusal = await until("the reply", 30_000, async () => (await voiceSaid(page, pressAt)).join(" ") || null);
  await quiet(page);
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const afterPress = mateMessages().slice(countBeforePress);
  report.press = {
    voice: await voiceSaid(page, pressAt),
    toTheBoard: /\b(board|tap)\b/iu.test(refusal),
    messagesAfter: afterPress,
    promptSent: afterPress.some((text) => text.includes("Merge https://github.com/example/web/pull/42")),
  };
  console.log("voice on press:", refusal, "| prompt sent:", (report.press as { promptSent: boolean }).promptSent);

  await page.getByRole("button", { name: "End", exact: true }).click();
  await page.getByText(/FirstMate voice ·/u).waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  report.endedMs = Date.now() - t0;
} catch (error) {
  if (!(error instanceof Done)) {
    report.error = error instanceof Error ? error.message : String(error);
    console.log("FAILED:", report.error);
  }
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
