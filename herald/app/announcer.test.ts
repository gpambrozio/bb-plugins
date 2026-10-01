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

function setup(
  overrides: {
    settings?: Partial<SpeechSettings>;
    platform?: SpeechPlatform;
    renderFails?: boolean;
    claimed?: Set<string>;
    unlocked?: boolean;
    /** Playback is refused: the say audio rejects and the browser voice is not heard. */
    refused?: boolean;
    /** Holds every playback until the test releases it. */
    hold?: Array<() => void>;
  } = {},
) {
  const order: string[] = [];
  const audio = {
    canPlayAudio: () => true,
    canSpeak: () => true,
    primeSpeech: vi.fn(() => order.push("prime")),
    isAudioUnlocked: () => overrides.unlocked ?? false,
    playAudio: vi.fn(async (url: string) => {
      order.push(`play:${url}`);
      if (overrides.hold !== undefined) await new Promise<void>((resolve) => overrides.hold?.push(resolve));
      if (overrides.refused === true) throw new Error("NotAllowedError");
    }),
    speak: vi.fn(async (text: string) => {
      order.push(`speak:${text}`);
      return overrides.refused !== true;
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
    // A claim set shared between two announcers stands for two windows of one app.
    claim: vi.fn(async (eventId: string) => {
      const claimed = overrides.claimed;
      const release = async () => {
        claimed?.delete(eventId);
      };
      if (claimed === undefined) return { release };
      if (claimed.has(eventId)) return null;
      claimed.add(eventId);
      return { release };
    }),
    audio,
    report: vi.fn(),
  };
  return { announcer: new Announcer(deps), deps, audio, order };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  setMutedHere(false);
  vi.useRealTimers();
});

describe("Announcer", () => {
  it("does not announce what was already waiting when the window opened", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([entry("a")]);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("speaks each new settled entry once, oldest first, in the server's voice", async () => {
    const { announcer, order } = setup();
    announcer.onEntries([]);
    const later = entry("b", { createdAt: "2026-09-15T10:05:00.000Z" });
    const earlier = entry("c", { createdAt: "2026-09-15T10:01:00.000Z" });
    announcer.onEntries([later, earlier]);
    announcer.onEntries([later, earlier]);
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
    announcer.onEntries([]);
    announcer.onEntries([entry("a", { summary: { status: "pending" } })]);
    announcer.onEntries([entry("b", { summary: { status: "off", fallback: "x" } })]);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
    announcer.onEntries([entry("a"), entry("b", { summary: { status: "off", fallback: "x" } })]);
    await settle();
    expect(deps.render).toHaveBeenCalledTimes(1);
  });

  it("speaks a failed summary's fallback", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([]);
    announcer.onEntries([entry("a", { summary: { status: "failed", error: "x", fallback: "Shop finished." } })]);
    await settle();
    expect(deps.render).toHaveBeenCalledWith("Shop finished.", "Zoe", 1);
  });

  it("speaks an announcement in one window of the app, not in every one", async () => {
    const claimed = new Set<string>();
    const first = setup({ claimed });
    const second = setup({ claimed });
    for (const window of [first, second]) window.announcer.onEntries([]);
    first.announcer.onEntries([entry("a")]);
    second.announcer.onEntries([entry("a")]);
    await settle();
    expect(first.deps.render).toHaveBeenCalledTimes(1);
    expect(second.deps.render).not.toHaveBeenCalled();
  });

  it("reports what it spoke, for the plugin's log", async () => {
    const { announcer, deps } = setup();
    announcer.onEntries([]);
    announcer.onEntries([entry("a")]);
    await settle();
    expect(deps.report).toHaveBeenCalledWith("info", 'Spoke (desktop): "Sentence a."');
  });

  it("follows the switches, and the mute on this device", async () => {
    const off = setup({ settings: { speak: false } });
    off.announcer.onEntries([]);
    off.announcer.onEntries([entry("a")]);
    const phone = setup({ platform: "mobile" });
    phone.announcer.onEntries([]);
    phone.announcer.onEntries([entry("a")]);
    await settle();
    const muted = setup();
    setMutedHere(true);
    muted.announcer.onEntries([]);
    muted.announcer.onEntries([entry("a")]);
    await settle();
    expect(off.deps.report).toHaveBeenCalledWith("info", 'Not speaking "Sentence a." here: Announcements are off in Herald\'s settings.');
    expect(off.deps.render).not.toHaveBeenCalled();
    expect(phone.deps.render).not.toHaveBeenCalled();
    expect(muted.deps.render).not.toHaveBeenCalled();
  });

  it("falls back to the browser voice when the server cannot render, and says so once", async () => {
    const { announcer, deps, order } = setup({ renderFails: true });
    announcer.onEntries([]);
    announcer.onEntries([entry("a"), entry("b", { createdAt: "2026-09-15T10:01:00.000Z" })]);
    await settle();
    expect(order.filter((step) => step.startsWith("speak:"))).toEqual(["speak:Sentence a.", "speak:Sentence b."]);
    expect(vi.mocked(deps.report).mock.calls.filter(([level]) => level === "warn")).toHaveLength(1);
  });

  it("uses the browser voice straight away when that is the chosen engine", async () => {
    const { announcer, deps, audio } = setup({ settings: { engine: "web", rate: 1.2 } });
    announcer.onEntries([]);
    announcer.onEntries([entry("a")]);
    await settle();
    expect(deps.render).not.toHaveBeenCalled();
    expect(audio.speak).toHaveBeenCalledWith("Sentence a.", { voice: "", rate: 1.2 });
  });

  it("primes the audio before its first await, and reports why an unforced press stayed quiet", async () => {
    const { announcer, audio, order } = setup({ settings: { speakOnDesktop: false } });
    const pressed = announcer.speakText("Sentence a.");
    // Synchronously, inside the press: nothing has been awaited yet.
    expect(audio.primeSpeech).toHaveBeenCalledTimes(1);
    await expect(pressed).resolves.toBe("Speaking in the desktop app is off in Herald's settings.");
    expect(order).toEqual(["prime"]);
  });

  it("speaks a forced press (Test voice, Read again) even when muted here", async () => {
    const { announcer, order } = setup();
    setMutedHere(true);
    await expect(announcer.speakText("Sentence a.", { force: true })).resolves.toBeNull();
    expect(order).toEqual(["prime", "render:Sentence a.", "play:data:audio/wav;base64,QUJD"]);
  });

  it("lets Test voice through the switches", async () => {
    const { announcer, order } = setup({ settings: { speak: false } });
    await expect(announcer.speakText("Testing.", { force: true })).resolves.toBeNull();
    expect(order).toEqual(["prime", "render:Testing.", "play:data:audio/wav;base64,QUJD"]);
  });

  it("does not claim a sentence in a tab that cannot play it unprompted", async () => {
    const claimed = new Set<string>();
    const untapped = setup({ platform: "browser", unlocked: false, claimed });
    const tapped = setup({ platform: "browser", unlocked: true, claimed });
    for (const window of [untapped, tapped]) window.announcer.onEntries([]);
    untapped.announcer.onEntries([entry("a")]);
    tapped.announcer.onEntries([entry("a")]);
    await settle();
    expect(untapped.deps.claim).not.toHaveBeenCalled();
    expect(untapped.deps.report).toHaveBeenCalledWith("info", 'Not speaking "Sentence a." here: this tab has not been tapped yet.');
    expect(tapped.deps.render).toHaveBeenCalledTimes(1);
  });

  it("gives the sentence back when its playback is refused, and another window then says it", async () => {
    const claimed = new Set<string>();
    const hold: Array<() => void> = [];
    const refusing = setup({ claimed, refused: true, hold });
    const working = setup({ claimed });
    for (const window of [refusing, working]) window.announcer.onEntries([]);
    refusing.announcer.onEntries([entry("a")]);
    await settle();
    // While the first window is still trying, the second loses the claim.
    working.announcer.onEntries([entry("a")]);
    await settle();
    expect(working.deps.render).not.toHaveBeenCalled();
    hold.shift()?.();
    await settle();
    expect(refusing.deps.report).toHaveBeenCalledWith("warn", 'Could not play "Sentence a." here; another window may say it.');
    expect(claimed.has("a")).toBe(false);
    // The release reaches the other window (the storage event, in the app).
    working.announcer.claimReleased("a");
    await settle();
    expect(working.audio.playAudio).toHaveBeenCalledTimes(1);
    expect(working.deps.report).toHaveBeenCalledWith("info", 'Spoke (desktop): "Sentence a."');
  });

  it("still says it when the claim comes back long after, however long the refused attempt took", async () => {
    vi.useFakeTimers();
    const claimed = new Set<string>(["a"]);
    const working = setup({ claimed });
    working.announcer.onEntries([]);
    working.announcer.onEntries([entry("a")]);
    await vi.advanceTimersByTimeAsync(0);
    // A 30 s render and a refused 400-character utterance: a minute and a half.
    await vi.advanceTimersByTimeAsync(90_000);
    working.announcer.onEntries([entry("a")]);
    claimed.delete("a");
    working.announcer.claimReleased("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(working.audio.playAudio).toHaveBeenCalledTimes(1);
  });

  it("does not say a released announcement that was withdrawn meanwhile, or one it never lost", async () => {
    const claimed = new Set<string>(["a"]);
    const { announcer, audio } = setup({ claimed });
    announcer.onEntries([]);
    announcer.onEntries([entry("a")]);
    await settle();
    // The thread moved on before the other window gave the claim back.
    announcer.onEntries([]);
    claimed.clear();
    announcer.claimReleased("a");
    announcer.claimReleased("never-seen");
    await settle();
    expect(audio.playAudio).not.toHaveBeenCalled();
  });

  it("drops a queued announcement that was withdrawn before its turn came", async () => {
    const hold: Array<() => void> = [];
    const { announcer, audio } = setup({ hold });
    announcer.onEntries([]);
    const first = entry("a");
    const second = entry("b", { createdAt: "2026-09-15T10:01:00.000Z" });
    announcer.onEntries([first, second]);
    await settle();
    expect(audio.playAudio).toHaveBeenCalledTimes(1);
    // The second thread resumes while the first sentence is still playing.
    announcer.onEntries([first]);
    hold.shift()?.();
    await settle();
    expect(audio.playAudio).toHaveBeenCalledTimes(1);
  });

  it("tells a press that the device would not play", async () => {
    const { announcer } = setup({ refused: true });
    await expect(announcer.speakText("Testing.", { force: true })).resolves.toBe(
      "This device would not play the sound. Press Test voice, then try again.",
    );
  });

  it("falls silent when stopped", async () => {
    const { announcer, audio, deps } = setup();
    announcer.onEntries([]);
    announcer.stop();
    announcer.onEntries([entry("a")]);
    await settle();
    expect(audio.stopSpeaking).toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });
});
