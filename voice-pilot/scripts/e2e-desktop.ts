// A live end-to-end run in a dev bb, never the owner's: headless Chromium opens the Voice page, taps Talk,
// and speaks `say` clips into a Web Audio stream that stands in for the microphone. The voice's words are
// read from the call's data channel, the question's answer from the dev bb's CLI. Adapted from
// firstmate-voice's e2e script.
//
//   node scripts/e2e-desktop.ts --url http://127.0.0.1:48906 --question <thread id> --bb <dev-bb CLI wrapper>
//
// It checks, in order: the voice speaks first (a greeting that names the running threads, before any word
// from the microphone); "what's waiting on me?" reads the pending question and its options; a spoken "Green"
// answers it with that option, and the voice says back what was sent; "goodbye" ends the session. Headless
// Chromium is not bb's desktop app (and faking `window.bbDesktop` breaks bb's own app), so with
// --desktop-host the page's `session.start` request is rewritten in flight to name that machine as a desktop
// client: the voice hooks then run there. It spends a minute or two of the connection's voice time, and
// saves screenshots beside the report.
//
// With --rich <thread id> (a thread whose latest reply has a ```ui table of pull requests), it asks what the
// table lists (read_reply), opens the first one by voice (open_link; the card says what was opened), then
// messages the thread and waits for its finished turn to be told from the reply. --question may be left out.
//
// With --noise, it first plays background noise into the microphone (a burst of white noise, a clap-like
// burst and a mumbled "hmm") and checks that none of it is answered, then asks a real question and times the
// answer from the end of the speech.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Page } from "playwright-core";

import { headlessChromium } from "./chromium.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:48906" },
    question: { type: "string" },
    bb: { type: "string" },
    out: { type: "string", default: join(process.env.TMPDIR ?? "/tmp", "vp-e2e") },
    answer: { type: "string", default: "Green" },
    "desktop-host": { type: "string" },
    /** Records the page (no sound) to a .webm in --out, for a GIF of the run. */
    video: { type: "boolean", default: false },
    /** Then by voice: find the tax thread and message it, and start a thread in the project. */
    actions: { type: "boolean", default: false },
    project: { type: "string" },
    /** What to say for the message, naming the thread by its topic. */
    tell: { type: "string", default: "Find the thread about the cart tax and tell it to also mention the tax rate." },
    /** A thread whose latest reply has a ```ui table of pull requests with links. */
    rich: { type: "string" },
    noise: { type: "boolean", default: false },
  },
});
const base = new URL(values.url);
if (base.port === "38886" || base.port === "38887") throw new Error("That is the owner's bb. Use a dev bb.");
if (values.bb === undefined) throw new Error("--bb is required.");
if (values.question === undefined && values.rich === undefined && !values.noise) throw new Error("--question, --rich or --noise is required.");
const questionThread = values.question ?? "";
const devBb = values.bb;
mkdirSync(values.out, { recursive: true });

function clip(text: string): string {
  const path = join(values.out, "clip.wav");
  execFileSync("say", ["-o", path, "--data-format=LEI16@24000", text]);
  return readFileSync(path).toString("base64");
}

/** The question thread's pending interactions as the dev bb lists them (an answered one leaves the list). */
function pendingIds(): string[] {
  const raw = execFileSync(devBb, ["thread", "interactions", "list", questionThread, "--json"], { encoding: "utf8" });
  return (JSON.parse(raw) as { id: string }[]).map((interaction) => interaction.id);
}

function interaction(id: string): { id: string; status: string; resolution: unknown } {
  return JSON.parse(execFileSync(devBb, ["thread", "interactions", "show", id, questionThread, "--json"], { encoding: "utf8" })) as { id: string; status: string; resolution: unknown };
}

/** The project's thread ids. */
function threadIds(projectId: string): string[] {
  const raw = execFileSync(devBb, ["thread", "list", "--project", projectId, "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(raw) as { id: string }[] | { threads: { id: string }[] };
  return (Array.isArray(parsed) ? parsed : parsed.threads).map((thread) => thread.id);
}

/** The session's debug log, through the dev bb's CLI. */
function debugEntries(): { at: number; kind: string; title: string; text?: string }[] {
  const input = join(values.out, "debug-in.json");
  writeFileSync(input, JSON.stringify({ afterSeq: 0 }));
  const raw = execFileSync(devBb, ["plugin", "rpc", "call", "voice-pilot", "debug.log", "--input-file", input], { encoding: "utf8" });
  type Entry = { at: number; kind: string; title: string; text?: string };
  const parsed = JSON.parse(raw) as { result?: { entries: Entry[] }; entries?: Entry[] };
  return parsed.result?.entries ?? parsed.entries ?? [];
}

/** A tool's answer as the session's debug log has it, the newest after `since`. */
function lastToolResult(_page: Page, since: number, tool: string): string | null {
  return debugEntries().filter((entry) => entry.at > since && entry.title === `Tool answer: ${tool}`).at(-1)?.text ?? null;
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

type DcEvent = { t: number; type: string; transcript?: string; name?: string };

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
    return last === undefined || ((last.type === "output_audio_buffer.stopped" || last.type === "output_audio_buffer.cleared") && Date.now() - last.t > 1_500);
  });
}

/** A noise clip as a 24 kHz WAV, from ffmpeg's `anoisesrc` and `aevalsrc` filters. */
function noiseClip(kind: "white" | "clap"): string {
  const path = join(values.out, `noise-${kind}.wav`);
  const source = kind === "white" ? "anoisesrc=d=1.5:c=white:a=0.25:r=24000" : "aevalsrc='0.8*random(0)*exp(-30*mod(t\\,0.35))':d=1.4:s=24000";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", source, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", path]);
  return readFileSync(path).toString("base64");
}

async function play(page: Page, b64: string, label: string): Promise<number> {
  const at = Date.now();
  const seconds = await page.evaluate((audio) => (window as unknown as { __speak(b64: string): Promise<number> }).__speak(audio), b64);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 300));
  console.log(`played: ${label}`);
  return at;
}

async function speak(page: Page, text: string): Promise<number> {
  const at = Date.now();
  const seconds = await page.evaluate((audio) => (window as unknown as { __speak(b64: string): Promise<number> }).__speak(audio), clip(text));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 300));
  console.log(`you said: ${text}`);
  return at;
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
let pageRef: Page | null = null;
const browser = await chromium.launch({ executablePath: headlessChromium(), args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: values.video ? 1 : 2,
    ...(values.video ? { recordVideo: { dir: values.out, size: { width: 1400, height: 900 } } } : {}),
  });
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const audio = new AudioContext({ sampleRate: 48_000 });
    const destination = audio.createMediaStreamDestination();
    // A real microphone always hears a little room noise; without it turn detection may never hear speech end.
    const noise = audio.createBuffer(1, 48_000, 48_000);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * 0.002;
    const floor = audio.createBufferSource();
    floor.buffer = noise;
    floor.loop = true;
    floor.connect(destination);
    floor.start();
    void audio.resume();
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
          const event = JSON.parse(String(message.data)) as { type: string; transcript?: string; name?: string };
          (w.__events as unknown[]).push({ t: Date.now(), type: event.type, transcript: event.transcript, name: event.name });
        } catch {
          // not JSON
        }
      });
      return channel;
    };
  });
  const questionId = values.question === undefined ? "" : pendingIds()[0];
  if (questionId === undefined) throw new Error(`${questionThread} has no pending question.`);
  const page = await context.newPage();
  pageRef = page;
  const desktopHost = values["desktop-host"];
  if (desktopHost !== undefined) {
    /** Names the machine in the RPC input that carries the offer, wherever bb nests it. */
    const asDesktop = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return false;
      const record = value as Record<string, unknown>;
      if (typeof record.sdp === "string" && "client" in record) {
        record.client = "desktop";
        record.hostId = desktopHost;
        return true;
      }
      return Object.values(record).some(asDesktop);
    };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.method() === "POST" ? request.postData() : null;
      if (body === null || !body.includes('"sdp"') || !body.includes('"client"')) return route.continue();
      const parsed = JSON.parse(body) as unknown;
      report.hooksAsDesktop = asDesktop(parsed);
      return route.continue({ postData: JSON.stringify(parsed) });
    });
  }
  await page.goto(new URL("/plugins/voice-pilot/voice", base).href, { waitUntil: "networkidle" });
  const talk = page.getByRole("button", { name: /^Talk$/u }).first();
  await talk.waitFor({ timeout: 30_000 }).catch(async (error) => {
    await page.screenshot({ path: join(values.out, "no-talk.png") });
    throw error;
  });
  await page.screenshot({ path: join(values.out, "page-idle.png") });
  const t0 = Date.now();
  await talk.click();
  await page.getByText(/Voice Pilot · (Listening|Speaking|Hearing you)/u).waitFor({ timeout: 30_000 });
  report.connectedMs = Date.now() - t0;

  // 1. It speaks first: no clip has been played into the microphone yet.
  const firstWords = await until("the greeting", 30_000, async () => (await voiceSaid(page, t0))[0]);
  report.greetingFirstWordsMs = (await events(page)).find((event) => event.type === "output_audio_buffer.started")?.t ?? null;
  if (typeof report.greetingFirstWordsMs === "number") report.greetingFirstWordsMs -= t0;
  await page.screenshot({ path: join(values.out, "page-greeting.png") });
  await quiet(page);
  const greetingEnd = (await events(page)).filter((event) => event.type === "output_audio_buffer.stopped").at(-1)?.t ?? Date.now();
  report.greeting = await voiceSaid(page, t0);
  report.greetingSpokenMs = greetingEnd - t0;
  console.log("greeting:", report.greeting, `(${firstWords.length} characters first)`);

  // 1b. Background noise is not answered; a real question still is (--noise).
  if (values.noise) {
    const noiseAt = Date.now();
    await play(page, noiseClip("white"), "white noise");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await play(page, noiseClip("clap"), "claps");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await play(page, clip("Hmm."), "a mumbled hmm");
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const all = await events(page);
    const after = all.filter((event) => event.t > noiseAt);
    const entries = debugEntries().filter((entry) => entry.at > noiseAt);
    report.noise = {
      speechDetected: after.filter((event) => event.type === "input_audio_buffer.speech_started").length,
      responses: after.filter((event) => event.type === "response.created").length,
      voiceSaid: await voiceSaid(page, noiseAt),
      ignored: entries.filter((entry) => entry.title.startsWith("Ignored: only noise")).map((entry) => entry.text ?? ""),
      heard: entries.filter((entry) => entry.kind === "heard").map((entry) => entry.text ?? ""),
    };
    console.log("noise:", JSON.stringify(report.noise));
    const askAt = await speak(page, "What's going on?");
    const answer = await until("an answer to a real question", 30_000, async () => {
      const list = await events(page);
      const stopped = list.find((event) => event.t > askAt && event.type === "input_audio_buffer.speech_stopped");
      const created = list.find((event) => event.t > askAt && event.type === "response.created");
      return stopped !== undefined && created !== undefined ? { stoppedToResponseMs: created.t - stopped.t } : null;
    });
    await quiet(page);
    report.realQuestion = { ...answer, said: await voiceSaid(page, askAt) };
    console.log("real question:", JSON.stringify(report.realQuestion));
  }

  if (values.question !== undefined) {
  // 2. What waits on me: the question and its options, read aloud.
  const askedAt = await speak(page, "What's waiting on me?");
  await until("the question read aloud", 45_000, async () => (await voiceSaid(page, askedAt)).join(" ").toLowerCase().includes(values.answer.toLowerCase()));
  await quiet(page);
  report.waiting = await voiceSaid(page, askedAt);
  report.waitingTools = (await events(page)).filter((event) => event.t > askedAt && event.type === "response.function_call_arguments.done").map((event) => event.name);
  console.log("voice on what waits:", report.waiting);

  // 3. The spoken choice answers it, and the voice says back what was sent.
  const answeredAt = await speak(page, values.answer);
  const resolved = await until("the question to be answered", 45_000, () => {
    const found = interaction(questionId);
    return found.status === "pending" ? null : found;
  });
  report.resolution = resolved;
  await quiet(page);
  report.saidBack = await voiceSaid(page, answeredAt);
  console.log("answered:", JSON.stringify(resolved.resolution), "| voice said back:", report.saidBack);
  await page.screenshot({ path: join(values.out, "page-answered.png") });
  }

  // 3a. A reply's table and links, and a finished turn told from its reply (--rich).
  if (values.rich !== undefined) {
    const richThread = values.rich;
    const tableAt = await speak(page, "Which pull requests are listed in the release review thread?");
    const read = await until("the reply read in full", 60_000, () => lastToolResult(page, tableAt, "read_reply"));
    await quiet(page);
    report.table = { result: read, said: await voiceSaid(page, tableAt) };
    console.log("table:", (report.table as { said: string[] }).said);

    const popups: string[] = [];
    page.context().on("page", (opened) => popups.push(opened.url()));
    const openAt = await speak(page, "Open the first one.");
    const opened = await until("a link opened", 45_000, () => lastToolResult(page, openAt, "open_link"));
    await quiet(page);
    const card = await page.getByText(/Opened |Could not open /u).first().textContent({ timeout: 10_000 }).catch(() => null);
    await page.screenshot({ path: join(values.out, "page-opened.png") });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    report.opened = { result: opened, card, popups: [...popups], said: await voiceSaid(page, openAt) };
    console.log("opened:", opened, "| card:", card, "| new tabs:", popups);

    const tellAt = await speak(page, "Tell the release review thread to add a third row for the docs fix, pull request twenty-two, which waits on me.");
    const told = await until("the message sent", 60_000, () => lastToolResult(page, tellAt, "send_message"));
    await quiet(page);
    console.log("told:", told);
    const queued = await until("the finished turn announced", 180_000, () =>
      debugEntries().find((entry) => entry.at > tellAt && entry.kind === "announce" && /finished/u.test(entry.title)),
    );
    const announcedAt = queued.at;
    await until("the voice to tell it", 60_000, async () => (await voiceSaid(page, announcedAt)).length > 0);
    await quiet(page);
    const news = debugEntries().filter((entry) => entry.at > tellAt && entry.kind === "context").map((entry) => entry.text ?? "");
    report.finished = { thread: richThread, queued: queued.title, item: news.at(-1) ?? null, said: await voiceSaid(page, announcedAt) };
    console.log("finished turn:", queued.title, "| voice said:", (report.finished as { said: string[] }).said);
    await page.screenshot({ path: join(values.out, "page-finished.png") });
  }

  // 3b. Doing things in bb: find a thread by topic and message it (--tell), then start a thread in the project.
  if (values.actions) {
    if (values.project === undefined) throw new Error("--actions needs --project.");
    const threadsBefore = threadIds(values.project);
    const messagedAt = await speak(page, values.tell);
    const toldTax = await until("a message in the tax thread", 60_000, () => lastToolResult(page, messagedAt, "send_message"));
    await quiet(page);
    report.message = { result: toldTax, said: await voiceSaid(page, messagedAt) };
    console.log("message:", toldTax, "| voice said:", report.message);
    const startedAt = await speak(page, "Start a new thread in Demo shop to write a one-line footer for the receipts.");
    const started = await until("a new thread in the project", 60_000, () => threadIds(values.project ?? "").find((id) => !threadsBefore.includes(id)));
    await quiet(page);
    report.started = { threadId: started, said: await voiceSaid(page, startedAt) };
    console.log("started:", started, "| voice said:", (report.started as { said: string[] }).said);
  }

  // 4. Goodbye ends it.
  const byeAt = await speak(page, "That's all, goodbye.");
  await page.getByText(/Voice ended/u).first().waitFor({ timeout: 30_000 });
  report.goodbye = await voiceSaid(page, byeAt);
  report.endedMs = Date.now() - t0;
  await page.screenshot({ path: join(values.out, "page-ended.png") });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.log("FAILED:", report.error);
  if (pageRef !== null) await pageRef.screenshot({ path: join(values.out, "failed.png") }).catch(() => undefined);
} finally {
  if (pageRef !== null) {
    report.events = await events(pageRef).catch(() => []);
    // Never leave a call running: End, if it is still there.
    await pageRef.getByRole("button", { name: "End", exact: true }).first().click({ timeout: 3_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  report.video = (await pageRef?.video()?.path().catch(() => null)) ?? null;
  await browser.close();
}
const out = join(values.out, `e2e-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Report: ${out}`);
