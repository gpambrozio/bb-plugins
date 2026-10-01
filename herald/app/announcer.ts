/**
 * The part that speaks. One runs per app window, started by the app-wide
 * overlay (`app/bridge.tsx`) so it lives whether or not the Herald panel is
 * on screen; the panel and the composer banner borrow it for their buttons.
 *
 * It is fed the entry list each time the overlay re-reads it — on every
 * realtime nudge from the server and on every reconnect — and speaks each
 * entry once, remembered by its event id. Whatever was already waiting when
 * the window opened is not news: the first list only seeds what has been said.
 */
import { speechText, type AttentionEntry, type VoicesConfig } from "../shared/herald";
import { blockedMessage, type SpeechPlatform, type SpeechSettings } from "../shared/settings";

export interface AnnouncerAudio {
  canPlayAudio(): boolean;
  canSpeak(): boolean;
  primeSpeech(): void;
  playAudio(dataUrl: string): Promise<void>;
  speak(text: string, options: { voice: string; rate: number }): Promise<void>;
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
  audio: AnnouncerAudio;
  warn(message: string, error: unknown): void;
}

export class Announcer {
  private readonly spoken = new Set<string>();
  private seeded = false;
  private stopped = false;
  private warnedSay = false;
  /** Deliveries queue behind one another, so a button press never talks over an announcement. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AnnouncerDeps) {}

  /**
   * Speaks what is new in `entries`. Only the window that leads speaks on its
   * own — two windows of one app would otherwise say everything twice — but
   * every window keeps count, so one that takes the lead later does not
   * repeat what was said before.
   */
  onEntries(entries: readonly AttentionEntry[], leading: boolean): void {
    const present = new Set(entries.map((entry) => entry.eventId));
    if (!this.seeded) {
      for (const id of present) this.spoken.add(id);
      this.seeded = true;
      return;
    }
    // Oldest first, so a batch that arrived together reads in order.
    const fresh = entries
      .filter((entry) => !this.spoken.has(entry.eventId) && entry.summary.status !== "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of fresh) {
      this.spoken.add(entry.eventId);
      const text = speechText(entry);
      if (text === null || !leading) continue;
      if (this.blocked() !== null) continue;
      void this.deliver(text);
    }
    // Forget ids that are gone; an event id never comes back.
    for (const id of [...this.spoken]) if (!present.has(id)) this.spoken.delete(id);
  }

  /**
   * Says one entry again. Resolves to null once it has played, or to the
   * reason this device stayed quiet, for the caller to show.
   *
   * Like `speakText`, its first statement runs in the press handler's own
   * task, which is the only place a browser grants audio: `primeSpeech()` goes
   * before the first `await`.
   */
  async speakEntry(entry: AttentionEntry, fallback: string): Promise<string | null> {
    this.deps.audio.primeSpeech();
    const blocked = this.blocked();
    if (blocked !== null) return blocked;
    await this.deliver(speechText(entry) ?? fallback);
    return null;
  }

  /**
   * `force` skips the switches, for *Test voice* alone: it is how the voice is
   * checked while announcements are off, and on the web it is the press that
   * hands the browser its audio permission. Gating it would disable it exactly
   * when someone is trying to get sound working.
   */
  async speakText(text: string, options: { force?: boolean } = {}): Promise<string | null> {
    this.deps.audio.primeSpeech();
    const blocked = options.force === true ? null : this.blocked();
    if (blocked !== null) return blocked;
    await this.deliver(text);
    return null;
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

  private deliver(text: string): Promise<void> {
    const next = this.chain.then(
      () => this.deliverNow(text),
      () => this.deliverNow(text),
    );
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * The server Mac's voice when asked for and reachable, the browser's voice
   * otherwise. A failed render or a refused playback falls through to the
   * browser voice rather than to silence, and is reported once.
   */
  private async deliverNow(text: string): Promise<void> {
    // Checked here rather than only at the call: this runs once per queued
    // delivery, and a reload can stop the announcer while one waits.
    if (this.stopped) return;
    const { audio } = this.deps;
    const settings = this.deps.settings();
    const voices = await this.deps.voices().catch((error: unknown) => {
      this.deps.warn("Could not read Herald's voices; using the defaults.", error);
      return { say: "", web: "" };
    });
    if (settings.engine === "say" && audio.canPlayAudio()) {
      try {
        const rendered = await this.deps.render(text, voices.say, settings.rate);
        if (this.stopped) return;
        await audio.playAudio(`data:${rendered.mimeType};base64,${rendered.base64}`);
        return;
      } catch (error) {
        if (!this.warnedSay) {
          this.warnedSay = true;
          this.deps.warn("The server's say voice is unavailable here; using the browser voice.", error);
        }
      }
    }
    if (this.stopped || !audio.canSpeak()) return;
    await audio.speak(text, { voice: voices.web, rate: settings.rate });
  }
}

/**
 * Muted on this device only, until the app reloads. Module scope, so it
 * survives navigating away from the panel and back; the settings are shared by
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

/** This window's announcer, for the panel's and the banner's buttons. Null until the overlay mounts. */
export function getAnnouncer(): Announcer | null {
  return active;
}

export function setAnnouncer(next: Announcer | null): void {
  active = next;
}
