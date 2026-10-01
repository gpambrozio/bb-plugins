import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import type { SpeechPlatform, SpeechSettings } from "../shared/settings";
import { Announcer, setMutedHere, type AnnouncerDeps } from "./announcer";

function entry(id: string, overrides: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    threadId: `t-${id}`,
    projectId: "p1",
    projectName: "Shop",
    threadTitle: null,
    lastRequest: null,
    folder: null,
    reason: "finished",
    eventId: id,
    requestId: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    headline: "Finished",
    detail: null,
    summary: { status: "ready", text: `Sentence ${id}.`, model: "m" },
    ...overrides,
  };
}

const SETTINGS: SpeechSettings = {
  speak: true,
  speakOnDesktop: true,
  speakInBrowser: true,
  speakOnMobile: false,
  engine: "say",
  rate: 1,
};

function setup(overrides: { settings?: Partial<SpeechSettings>; platform?: SpeechPlatform; renderFails?: boolean } = {}) {
  const order: string[] = [];
  const audio = {
    canPlayAudio: () => true,
    canSpeak: () => true,
    primeSpeech: vi.fn(() => order.push("prime")),
    playAudio: vi.fn(async (url: string) => {
      order.push(`play:${url}`);
    }),
    speak: vi.fn(async (text: string) => {
      order.push(`speak:${text}`);
    }),
    stopAudio: vi.fn(),
    stopSpeaking: vi.fn(),
  };
  const deps: AnnouncerDeps = {
    render: vi.fn(async (text: string) => {
      order.push(`render:${text}`);
      if (overrides.renderFails === true) throw new Error("not a Mac");
      return { mimeType: "audio/wav", base64: "QUJD" };
    }),
    voices: async () => ({ say: "Zoe", web: "" }),
    settings: () => ({ ...SETTINGS, ...overrides.settings }),
    platform: () => overrides.platform ?? "desktop",
    audio,
    warn: vi.fn(),
  };
  return { announcer: new Announcer(deps), deps, audio, order };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  setMutedHere(false);
});

describe("Announcer", () => {
  it("does not announce what was already waiting when the window opened", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([entry("a")], true);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("speaks each new settled entry once, oldest first, in the server's voice", async () => {
    const { announcer, order } = setup();
    announcer.onEntries([], true);
    const later = entry("b", { createdAt: "2026-09-15T10:05:00.000Z" });
    const earlier = entry("c", { createdAt: "2026-09-15T10:01:00.000Z" });
    announcer.onEntries([later, earlier], true);
    announcer.onEntries([later, earlier], true);
    await settle();
    expect(order).toEqual([
      "render:Sentence c.",
      "play:data:audio/wav;base64,QUJD",
      "render:Sentence b.",
      "play:data:audio/wav;base64,QUJD",
    ]);
  });

  it("waits for a pending summary and never speaks a switched-off one", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([], true);
    announcer.onEntries([entry("a", { summary: { status: "pending" } })], true);
    announcer.onEntries([entry("b", { summary: { status: "off", fallback: "x" } })], true);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
    announcer.onEntries([entry("a"), entry("b", { summary: { status: "off", fallback: "x" } })], true);
    await settle();
    expect(deps.render).toHaveBeenCalledTimes(1);
  });

  it("speaks a failed summary's fallback", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([], true);
    announcer.onEntries([entry("a", { summary: { status: "failed", error: "x", fallback: "Shop finished." } })], true);
    await settle();
    expect(deps.render).toHaveBeenCalledWith("Shop finished.", "Zoe", 1);
  });

  it("keeps count but stays quiet in a window that does not lead", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([], false);
    announcer.onEntries([entry("a")], false);
    // Taking the lead later does not repeat it.
    announcer.onEntries([entry("a")], true);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("follows the switches, and the mute on this device", async () => {
    const off = setup({ settings: { speak: false } });
    off.announcer.onEntries([], true);
    off.announcer.onEntries([entry("a")], true);
    const phone = setup({ platform: "mobile" });
    phone.announcer.onEntries([], true);
    phone.announcer.onEntries([entry("a")], true);
    const muted = setup();
    setMutedHere(true);
    muted.announcer.onEntries([], true);
    muted.announcer.onEntries([entry("a")], true);
    await settle();
    expect(off.deps.render).not.toHaveBeenCalled();
    expect(phone.deps.render).not.toHaveBeenCalled();
    expect(muted.deps.render).not.toHaveBeenCalled();
  });

  it("falls back to the browser voice when the server cannot render, and says so once", async () => {
    const { announcer, deps, order } = setup({ renderFails: true });
    announcer.onEntries([], true);
    announcer.onEntries([entry("a"), entry("b", { createdAt: "2026-09-15T10:01:00.000Z" })], true);
    await settle();
    expect(order.filter((step) => step.startsWith("speak:"))).toEqual(["speak:Sentence a.", "speak:Sentence b."]);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it("uses the browser voice straight away when that is the chosen engine", async () => {
    const { announcer, deps, audio } = setup({ settings: { engine: "web", rate: 1.2 } });
    announcer.onEntries([], true);
    announcer.onEntries([entry("a")], true);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
    expect(audio.speak).toHaveBeenCalledWith("Sentence a.", { voice: "", rate: 1.2 });
  });

  it("primes the audio before its first await, and reports why a pressed button stayed quiet", async () => {
    const { announcer, audio, order } = setup({ settings: { speakOnDesktop: false } });
    const pressed = announcer.speakEntry(entry("a"), "Shop is waiting.");
    // Synchronously, inside the press: nothing has been awaited yet.
    expect(audio.primeSpeech).toHaveBeenCalledTimes(1);
    await expect(pressed).resolves.toBe("Speaking in the desktop app is off in Herald's settings.");
    expect(order).toEqual(["prime"]);
  });

  it("lets Test voice through the switches", async () => {
    const { announcer, order } = setup({ settings: { speak: false } });
    await expect(announcer.speakText("Testing.", { force: true })).resolves.toBeNull();
    expect(order).toEqual(["prime", "render:Testing.", "play:data:audio/wav;base64,QUJD"]);
  });

  it("falls silent when stopped", async () => {
    const { announcer, audio, deps } = setup();
    announcer.onEntries([], true);
    announcer.stop();
    announcer.onEntries([entry("a")], true);
    await settle();
    expect(audio.stopSpeaking).toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });
});
