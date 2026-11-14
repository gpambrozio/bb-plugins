// What this client is and what it allows: the capability list, a beep after a
// tap (both engines: Web Audio and an <audio> element), and the screen Wake Lock.

export type Platform = "desktop" | "mobile" | "browser";

/** The way Herald and bb's push-notifications plugin tell the clients apart (herald/app/speech.ts). */
export function platform(): Platform {
  if ("bbDesktop" in window) return "desktop";
  const bb = (window as { bb?: unknown }).bb;
  if (typeof bb === "object" && bb !== null && "native" in bb) return "mobile";
  return "browser";
}

export function capabilities() {
  const nav = navigator as Navigator & { wakeLock?: unknown };
  return {
    platform: platform(),
    userAgent: navigator.userAgent,
    origin: window.location.origin,
    secureContext: window.isSecureContext,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    RTCPeerConnection: typeof window.RTCPeerConnection === "function",
    AudioContext: typeof window.AudioContext === "function",
    wakeLock: typeof nav.wakeLock === "object" && nav.wakeLock !== null,
    WebSocket: typeof window.WebSocket === "function",
  };
}

/** A 0.3 s 440 Hz beep as a WAV, for the <audio> element test. */
function beepWavUrl(): string {
  const rate = 16_000;
  const samples = Math.round(rate * 0.3);
  const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, value: string) => [...value].forEach((char, i) => bytes.setUint8(offset + i, char.charCodeAt(0)));
  text(0, "RIFF");
  bytes.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, rate, true);
  bytes.setUint32(28, rate * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  text(36, "data");
  bytes.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) bytes.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
  return URL.createObjectURL(new Blob([bytes.buffer], { type: "audio/wav" }));
}

/** Call from the tap handler itself, before any await. */
export async function beepAfterTap(context: AudioContext) {
  const result: Record<string, string> = {};
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.1;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.25);
  const element = new Audio(beepWavUrl());
  const played = element.play();
  try {
    await context.resume();
    result.webAudio = context.state;
  } catch (error) {
    result.webAudio = `failed: ${(error as Error).name}`;
  }
  try {
    await played;
    result.audioElement = "played";
  } catch (error) {
    result.audioElement = `refused: ${(error as Error).name}`;
  }
  return result;
}

export async function wakeLockCheck(): Promise<string> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void>; released: boolean }> } };
  if (!nav.wakeLock) return "unavailable (no navigator.wakeLock)";
  try {
    const lock = await nav.wakeLock.request("screen");
    const held = !lock.released;
    await lock.release();
    return held ? "granted (screen), released" : "granted but already released";
  } catch (error) {
    return `refused: ${(error as Error).name} ${(error as Error).message}`;
  }
}
