/**
 * The part that speaks. One runs per app window, started by the app-wide
 * overlay (`app/bridge.tsx`), so it speaks whether or not the Herald page is
 * open and whatever page the window shows; the page and the composer banner
 * borrow it for their buttons.
 *
 * It is fed the entry list each time the overlay re-reads it — on every
 * realtime nudge from the server and on every reconnect — and speaks each
 * entry once, remembered by its event id. Whatever was already waiting when
 * the window opened is not news: the first list only seeds what has been said.
 */
import { speechText, type AttentionEntry, type VoicesConfig } from "../shared/herald";
import { blockedMessage, type SpeechPlatform, type SpeechSettings } from "../shared/settings";
import type { Claim } from "./claims";

export interface AnnouncerAudio {
  canPlayAudio(): boolean;
  canSpeak(): boolean;
  primeSpeech(): void;
  /** Whether this page has been heard, or primed by a press, so it may play on its own. */
  isAudioUnlocked(): boolean;
  playAudio(dataUrl: string): Promise<void>;
  /** True when the utterance was heard, false when the browser refused it. */
  speak(text: string, options: { voice: string; rate: number }): Promise<boolean>;
  stopAudio(): void;
  stopSpeaking(): void;
}

export interface AnnouncerDeps {
  /** The server Mac's `say`, rendered to audio; rejects when it cannot. */
  render(text: string, voice: string, rate: number): Promise<{ mimeType: string; base64: string }>;
  voices(): Promise<VoicesConfig>;
  /** The host form's values as they stand now. */
  settings(): SpeechSettings;
  platform(): SpeechPlatform;
  /**
   * Whether this window is the one to say an announcement. Two windows of one
   * app would otherwise say everything twice; see `app/claims.ts`.
   */
  claim(eventId: string): Promise<Claim | null>;
  audio: AnnouncerAudio;
  /** What was said, and why something was not, for `bb plugin logs herald`. */
  report(level: "info" | "warn", message: string, error?: unknown): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = "spoke" | "refused" | "skipped";

export class Announcer {
  private readonly spoken = new Set<string>();
  /** The event ids in the latest list; an announcement no longer in it was withdrawn. */
  private current = new Set<string>();
  /**
   * Announcements another window claimed, by event id, kept until that window
   * gives the claim back (`claimReleased`) or the announcement is withdrawn.
   */
  private readonly lost = new Map<string, string>();
  private seeded = false;
  private stopped = false;
  private warnedSay = false;
  /** Deliveries queue behind one another, so a button press never talks over an announcement. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AnnouncerDeps) {}

  /** Speaks what is new in `entries`, oldest first. */
  onEntries(entries: readonly AttentionEntry[]): void {
    const present = new Set(entries.map((entry) => entry.eventId));
    this.current = present;
    if (!this.seeded) {
      for (const id of present) this.spoken.add(id);
      this.seeded = true;
      return;
    }
    const fresh = entries
      .filter((entry) => !this.spoken.has(entry.eventId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of fresh) {
      this.spoken.add(entry.eventId);
      const text = speechText(entry);
      if (text === null) continue;
      void this.deliver(text, entry.eventId, false).catch((error: unknown) =>
        this.deps.report("warn", `Could not speak an announcement: ${describe(error)}`, error),
      );
    }
    // Forget ids that are gone; an event id never comes back.
    for (const id of [...this.spoken]) if (!present.has(id)) this.spoken.delete(id);
    for (const id of [...this.lost.keys()]) if (!present.has(id)) this.lost.delete(id);
  }

  /**
   * Says `text` now, for a pressed button. Resolves to null once it has
   * played, or to the reason this device stayed quiet, for the caller to show.
   *
   * Its first statement runs in the press handler's own task, which is the
   * only place a browser grants audio: `primeSpeech()` goes before the first
   * `await`.
   *
   * `force` skips the switches and the mute on this device. *Test voice* and
   * *Read again* pass it: an explicit press means "say it here, now", it is
   * how the voice is checked while announcements are off, and on the web it is
   * the press that hands the browser its audio permission.
   */
  async speakText(text: string, options: { force?: boolean } = {}): Promise<string | null> {
    this.deps.audio.primeSpeech();
    const blocked = options.force === true ? null : this.blocked();
    if (blocked !== null) return blocked;
    const outcome = await this.deliver(text, null, false);
    return outcome === "refused" ? "This device would not play the sound. Press Test voice, then try again." : null;
  }

  /**
   * Another window gave back its claim on `eventId` — its playback was
   * refused. If this window lost that announcement, it tries again now, with
   * the same checks as the first time: still current, not muted or off.
   */
  claimReleased(eventId: string): void {
    const text = this.lost.get(eventId);
    if (text === undefined) return;
    this.lost.delete(eventId);
    void this.deliver(text, eventId, true).catch((error: unknown) =>
      this.deps.report("warn", `Could not speak an announcement: ${describe(error)}`, error),
    );
  }

  /** A reload starts a new announcer at once, so this one must fall silent or the two talk over each other. */
  stop(): void {
    this.stopped = true;
    this.deps.audio.stopSpeaking();
    this.deps.audio.stopAudio();
  }

  private blocked(): string | null {
    return blockedMessage(this.deps.settings(), this.deps.platform(), isMutedHere());
  }

  /**
   * `eventId` is set for an announcement, which is gated and claimed; null for
   * a press. `retrying` is set when another window gave the claim back.
   */
  private deliver(text: string, eventId: string | null, retrying: boolean): Promise<Outcome> {
    const next = this.chain.then(
      () => this.deliverNow(text, eventId, retrying),
      () => this.deliverNow(text, eventId, retrying),
    );
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async deliverNow(text: string, eventId: string | null, retrying: boolean): Promise<Outcome> {
    // Checked here rather than only at the call: this runs once per queued
    // delivery, and a reload can stop the announcer while one waits.
    if (this.stopped) return "skipped";
    let claim: Claim | null = null;
    if (eventId !== null) {
      // Withdrawn while it waited — the thread moved on, or was answered.
      if (!this.current.has(eventId)) return "skipped";
      // Gated when it is said, not when it arrived: a switch flipped while it
      // waited in the queue still counts.
      const blocked = this.blocked();
      if (blocked !== null) {
        if (!retrying) this.deps.report("info", `Not speaking "${text}" here: ${blocked}`);
        return "skipped";
      }
      // A window that cannot make a sound unprompted must not take the
      // sentence from one that can.
      if (this.deps.platform() !== "desktop" && !this.deps.audio.isAudioUnlocked()) {
        if (!retrying) {
          this.deps.report("info", `Not speaking "${text}" here: this ${this.deps.platform() === "mobile" ? "app" : "tab"} has not been tapped yet.`);
        }
        return "skipped";
      }
      claim = await this.deps.claim(eventId);
      if (claim === null) {
        // Another window is saying it. Kept until it says so, or gives it back.
        this.lost.set(eventId, text);
        return "skipped";
      }
    }
    const outcome = await this.play(text);
    if (eventId !== null) {
      if (outcome === "spoke") this.deps.report("info", `Spoke (${this.deps.platform()}): "${text}"`);
      else {
        await claim?.release();
        this.deps.report("warn", `Could not play "${text}" here; another window may say it.`);
      }
    }
    return outcome;
  }

  /**
   * The server Mac's voice when asked for and reachable, the browser's voice
   * otherwise. A failed render or a refused playback falls through to the
   * browser voice rather than to silence, and is reported once.
   */
  private async play(text: string): Promise<Outcome> {
    const { audio } = this.deps;
    const settings = this.deps.settings();
    const voices = await this.deps.voices().catch((error: unknown) => {
      this.deps.report("warn", `Could not read Herald's voices; using the defaults: ${describe(error)}`, error);
      return { say: "", web: "" };
    });
    if (settings.engine === "say" && audio.canPlayAudio()) {
      try {
        const rendered = await this.deps.render(text, voices.say, settings.rate);
        if (this.stopped) return "skipped";
        await audio.playAudio(`data:${rendered.mimeType};base64,${rendered.base64}`);
        return "spoke";
      } catch (error) {
        if (!this.warnedSay) {
          this.warnedSay = true;
          this.deps.report("warn", `The server's say voice could not play here; using the browser voice: ${describe(error)}`, error);
        }
      }
    }
    if (this.stopped) return "skipped";
    if (!audio.canSpeak()) return "refused";
    return (await audio.speak(text, { voice: voices.web, rate: settings.rate })) ? "spoke" : "refused";
  }
}

/**
 * Muted on this device only, until the app reloads. Module scope, so it
 * survives navigating away from the page and back; the settings are shared by
 * every device, which is the wrong place for "not right now, not here".
 */
let mutedHere = false;
const muteListeners = new Set<() => void>();

export function isMutedHere(): boolean {
  return mutedHere;
}

export function setMutedHere(muted: boolean): void {
  mutedHere = muted;
  for (const listener of muteListeners) listener();
}

export function onMuteChange(listener: () => void): () => void {
  muteListeners.add(listener);
  return () => muteListeners.delete(listener);
}

let active: Announcer | null = null;

/** This window's announcer, for the page's and the banner's buttons. Null until the overlay mounts. */
export function getAnnouncer(): Announcer | null {
  return active;
}

export function setAnnouncer(next: Announcer | null): void {
  active = next;
}
