/**
 * Every browser audio global Herald touches: the `<audio>` element, the Web
 * Speech API, and which bb client this is.
 *
 * The bb app is web React everywhere — the desktop app is Electron, and the
 * mobile app is a native shell around the same web app in a WebView — so the
 * same two engines exist on every client. What differs is when a page may
 * make a sound: Electron plays unprompted; a browser tab and the mobile
 * app's WebView refuse `play()` and `speak()` until the page has been tapped,
 * and the mobile app is suspended whenever it leaves the screen.
 */
import type { SpeechPlatform } from "../shared/settings";

/**
 * Which bb client this is, read the way bb's own push-notifications plugin
 * reads it: the desktop shell exposes `window.bbDesktop`, the mobile shell a
 * `window.bb.native` bridge, and a browser tab neither.
 */
export function speechPlatform(): SpeechPlatform {
  if (typeof window === "undefined") return "browser";
  if ("bbDesktop" in window) return "desktop";
  const bb = (window as { bb?: unknown }).bb;
  if (typeof bb === "object" && bb !== null && "native" in bb) return "mobile";
  return "browser";
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

export function canPlayAudio(): boolean {
  return typeof window !== "undefined" && typeof window.Audio === "function";
}

/**
 * Whether anything here can make a sound: either engine will do. Every play
 * control is hidden where this is false, rather than shown and failing.
 */
export function canPlaySpeech(): boolean {
  return canPlayAudio() || canSpeak();
}

export interface Voice {
  name: string;
  lang: string;
}

/** Empty until the browser has loaded its voice list; see `onVoicesChanged`. */
export function listBrowserVoices(): Voice[] {
  if (!canSpeak()) return [];
  return window.speechSynthesis
    .getVoices()
    .map((voice) => ({ name: voice.name, lang: voice.lang }))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

export function onVoicesChanged(listener: () => void): () => void {
  if (!canSpeak()) return () => {};
  window.speechSynthesis.addEventListener("voiceschanged", listener);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", listener);
}

export interface SpeakOptions {
  /** A voice name from `listBrowserVoices`, or empty for the platform default. */
  voice: string;
  rate: number;
}

/**
 * Chromium collects an utterance that nothing references before it ends, and
 * then never fires `onend`; holding it here until it finishes is the known
 * workaround.
 */
const inFlight = new Set<SpeechSynthesisUtterance>();

/**
 * Resolves when the utterance ends: true when it was heard, false when the
 * browser refused it. A browser that dropped the call for lack of a tap fires
 * nothing at all, so a guard timer resolves it too — true only if the
 * utterance had started. Rejects only when there is no speech synthesis here.
 */
export function speak(text: string, options: SpeakOptions): Promise<boolean> {
  if (!canSpeak()) return Promise.reject(new Error("Speech synthesis is not available here."));
  const synth = window.speechSynthesis;
  return new Promise<boolean>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = options.rate;
    if (options.voice !== "") {
      const match = synth.getVoices().find((voice) => voice.name === options.voice);
      if (match !== undefined) utterance.voice = match;
    }
    let started = false;
    let settled = false;
    const finish = (heard: boolean) => {
      if (settled) return;
      settled = true;
      inFlight.delete(utterance);
      if (heard) unlocked = true;
      resolve(heard);
    };
    utterance.onstart = () => {
      started = true;
    };
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    inFlight.add(utterance);
    setTimeout(() => finish(started), Math.max(8_000, text.length * 150));
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

/**
 * One element for every playback, made on first use. WebKit unlocks the
 * *element* a gesture played, not the page, so reusing this one is what makes
 * `primeSpeech()` carry to the announcements that follow.
 */
let player: HTMLAudioElement | null = null;

/** Settles the playback in progress, so `stopAudio` need not strand its caller. */
let settlePlayer: (() => void) | null = null;

/**
 * Whether this page may play sound on its own: set once a playback or an
 * utterance has actually been heard, or a press has primed the element. Not
 * inferred from the element's `src` — a refused automatic playback sets that
 * too, and must not stop the next press from priming.
 */
let unlocked = false;

export function isAudioUnlocked(): boolean {
  return unlocked;
}

function audioPlayer(): HTMLAudioElement | null {
  if (!canPlayAudio()) return null;
  player ??= new Audio();
  return player;
}

/** A 1 ms 8 kHz silence: enough to unlock playback, inaudible. */
const SILENT_WAV = "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";

/**
 * Takes the permission a browser grants for audio, in the caller's own task.
 *
 * A browser allows audio only when a gesture asked for it, and the permission
 * belongs to the *task the gesture runs in* — which the real delivery is never
 * in, because it first awaits a render RPC. So every press handler calls this
 * synchronously, before its first `await`: it starts a silent clip on the
 * element every later playback reuses and speaks an inaudible utterance,
 * unlocking both engines. That is what makes "tap Test voice once" work.
 */
export function primeSpeech(): void {
  const element = audioPlayer();
  if (element !== null && !unlocked) {
    element.src = SILENT_WAV;
    const played = element.play() as Promise<void> | undefined;
    void played?.then(
      () => {
        unlocked = true;
      },
      () => {},
    );
  }
  if (canSpeak() && !window.speechSynthesis.speaking) {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
  }
}

/**
 * Plays audio the server rendered, handed over as a data URL. Resolves when it
 * ends; rejects when the browser refuses — a page not yet tapped, a format it
 * cannot decode — so the caller can fall back to the browser voice.
 */
export function playAudio(dataUrl: string): Promise<void> {
  const element = audioPlayer();
  if (element === null) return Promise.reject(new Error("Audio playback is not available here."));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    /** `heard` is false for a playback cut short by `stopAudio`, which proves nothing about unlocking. */
    const finish = (error: unknown, heard = true) => {
      if (settled) return;
      settled = true;
      if (settlePlayer === stop) settlePlayer = null;
      element.onended = null;
      element.onerror = null;
      if (error === null) {
        if (heard) unlocked = true;
        resolve();
      } else {
        reject(error instanceof Error ? error : new Error("The browser could not play the audio."));
      }
    };
    const stop = () => finish(null, false);
    settlePlayer = stop;
    element.onended = () => finish(null);
    element.onerror = (event) => finish(event);
    element.src = dataUrl;
    element.play().then(
      () => {
        unlocked = true;
      },
      (error: unknown) => finish(error),
    );
  });
}

/** Ends the playback in progress, settling its caller rather than stranding it. */
export function stopAudio(): void {
  if (player === null) return;
  player.pause();
  const settle = settlePlayer;
  settlePlayer = null;
  settle?.();
}

/** For tests: forget that this page was unlocked. */
export function resetAudioForTests(): void {
  unlocked = false;
  player = null;
  settlePlayer = null;
}
