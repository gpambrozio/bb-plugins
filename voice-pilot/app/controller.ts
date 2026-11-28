/**
 * The voice session as this window sees it: one controller per window, so the palette command, the header
 * button, the Voice page and the toast share it, and it outlives navigation (the toast is an app overlay,
 * which also holds the call). Adapted from firstmate-voice's controller. The window tells the server which
 * thread is on its screen (for "this thread"), and shows a thread when the voice asks for one.
 *
 * Talk unlocks audio inside the tap, before anything is awaited (a browser tab and the mobile app play
 * nothing otherwise), asks for the microphone with echo cancellation, makes the offer, and lets the bb
 * server do the SDP exchange. Mute disables the microphone track; End tells the server, which hangs up.
 * The server asks for a renewal near the hour's cap and announces the end. In bb's mobile app, which is
 * suspended when it leaves the screen, leaving it pauses the session: the microphone and the call go, the
 * server keeps the session, and coming back makes a new leg on a new microphone stream (`session.resume`),
 * the way a renewal does; Resume does the same by hand when that fails. Talk also names the window's bb client
 * and, in bb's desktop app, its machine (`app/machine.ts`), where the server runs the voice hooks.
 */
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "../server";
import type { SessionSignal } from "../server/session";
import { ALIVE_EVERY_MS } from "../shared/channel";
import { voicePlatform } from "./platform";
import { openLeg, type Leg, type SpeakingState } from "./webrtc";

type Rpc = PluginRpcClient<typeof rpcContract>;

export type VoicePhase = "idle" | "connecting" | "live" | "paused" | "resuming" | "ending";

export interface VoiceState {
  phase: VoicePhase;
  muted: boolean;
  speaking: SpeakingState;
  /** Why the last session ended, or why Talk failed, for the pill; null when there is nothing to say. */
  note: string | null;
  /** What the voice last opened in this window, for the session card; null when nothing yet. */
  opened: { label: string; ok: boolean } | null;
}

const IDLE: VoiceState = { phase: "idle", muted: false, speaking: { user: false, voice: false }, note: null, opened: null };

/** Opens a web link from this window: true when bb took it. */
export type LinkOpener = (url: string) => boolean;

type WakeLock = { release(): Promise<void> };

export class VoiceController {
  private state: VoiceState = IDLE;
  private readonly listeners = new Set<() => void>();
  private rpc: Rpc | null = null;
  /** This window's bb machine, for the voice hooks; null until the overlay hands it over. */
  private machine: (() => Promise<string | null>) | null = null;
  /** Shows a thread in this window, when the voice asks; handed over by the overlay. */
  private navigate: ((threadId: string) => void) | null = null;
  /** Opens a link from this window, when the voice asks; handed over by the overlay. */
  private openLink: LinkOpener | null = null;
  /** The thread on this window's screen, as the overlay last said. */
  private focusedThread: string | null = null;
  private sessionId: string | null = null;
  private stream: MediaStream | null = null;
  private leg: Leg | null = null;
  private audio: HTMLAudioElement | null = null;
  private wakeLock: WakeLock | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /**
   * Which Talk is current. Every await in a connection or a renewal checks it, so an End (or a new Talk)
   * while one is pending leaves that attempt to clean up its own microphone, leg and server session.
   */
  private attempt = 0;
  /** bb's mobile app leaving the screen pauses a live session, and coming back picks it up. */
  private readonly onVisibility = () => {
    if (voicePlatform() !== "mobile") return;
    if (document.visibilityState === "hidden") {
      if (this.state.phase === "connecting") void this.end("bb left the screen");
      else if (this.state.phase === "live" || this.state.phase === "resuming") this.pause("bb left the screen");
    } else if (this.state.phase === "paused") void this.resume();
  };

  /** The overlay hands its RPC client over once mounted; commands and buttons use it. */
  attach(rpc: Rpc, machine?: () => Promise<string | null>, navigate?: (threadId: string) => void, openLink?: LinkOpener): void {
    this.rpc = rpc;
    if (machine !== undefined) this.machine = machine;
    if (navigate !== undefined) this.navigate = navigate;
    if (openLink !== undefined) this.openLink = openLink;
  }

  /** The thread on this window's screen changed: the live session hears of it. */
  focus(threadId: string | null): void {
    if (threadId === this.focusedThread) return;
    this.focusedThread = threadId;
    const sessionId = this.sessionId;
    if (sessionId !== null && this.state.phase === "live") void this.rpc?.call("session.focus", { sessionId, threadId }).catch(() => null);
  }

  get snapshot(): VoiceState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<VoiceState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** A session is up here: connecting, live, or paused while bb was off the phone's screen. */
  get active(): boolean {
    const { phase } = this.state;
    return phase === "connecting" || phase === "live" || phase === "paused" || phase === "resuming";
  }

  /** Talk, or End when a session is already up. */
  toggle(): void {
    if (this.active) void this.end("ended by you");
    else this.talk();
  }

  /** Must run inside the tap or key press: the audio element is started before anything is awaited. */
  talk(): void {
    if (this.active || this.state.phase === "ending") return;
    const rpc = this.rpc;
    if (rpc === null) {
      this.set({ note: "Voice Pilot is still loading. Try again in a moment." });
      return;
    }
    const audio = (this.audio ??= new Audio());
    audio.autoplay = true;
    void audio.play().catch(() => undefined);
    this.set({ phase: "connecting", muted: false, note: null, opened: null, speaking: { user: false, voice: false } });
    this.attempt += 1;
    void this.connect(rpc, audio, this.attempt);
  }

  private async connect(rpc: Rpc, audio: HTMLAudioElement, attempt: number): Promise<void> {
    let stream: MediaStream | null = null;
    let leg: Leg | null = null;
    let made: string | null = null;
    const current = () => attempt === this.attempt && this.state.phase === "connecting";
    // Looked up beside the microphone prompt, so it adds no wait; a lookup that fails runs no hooks.
    const client = voicePlatform();
    const machine = client === "desktop" && this.machine !== null ? this.machine().catch(() => null) : Promise.resolve(null);
    /** This attempt's own microphone, leg and server session, whatever became of the controller since. */
    const abandon = async (reason: string) => {
      leg?.close();
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (made !== null) await rpc.call("session.end", { sessionId: made, reason }).catch(() => null);
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) return void (await abandon("ended while connecting"));
      leg = await this.newLeg(stream, audio);
      if (!current()) return void (await abandon("ended while connecting"));
      const started = await rpc.call("session.start", { sdp: leg.offer, hostId: await machine, client, threadId: this.focusedThread });
      made = started.sessionId;
      if (!current()) return void (await abandon("ended while connecting"));
      this.stream = stream;
      this.sessionId = started.sessionId;
      this.leg = leg;
      await leg.accept(started.answerSdp);
      await leg.connected();
      if (!current()) return void (await abandon("ended while connecting"));
      this.set({ phase: "live" });
      this.heartbeat = setInterval(() => void this.beat(), ALIVE_EVERY_MS);
      document.addEventListener("visibilitychange", this.onVisibility);
      await this.keepAwake(attempt);
    } catch (error) {
      // The server made the call but this side cannot hold it: hang it up now, not at the heartbeat's end.
      await abandon("the device could not connect");
      if (attempt === this.attempt) this.teardown(talkFailure(error));
    }
  }

  /**
   * Lets the microphone and the call go and keeps the session: the server is told (`tell`), unless it is
   * the one that paused it. A phone suspended before the word got out is paused there all the same, when its
   * heartbeat stops.
   */
  pause(reason: string, tell = true): void {
    const sessionId = this.sessionId;
    if (sessionId === null || (this.state.phase !== "live" && this.state.phase !== "resuming")) return;
    this.attempt += 1;
    this.release();
    this.set({ phase: "paused", speaking: { user: false, voice: false }, note: null });
    if (tell) void this.rpc?.call("session.pause", { sessionId, reason }).catch(() => null);
  }

  /** Back on the screen, or Resume tapped: a new microphone stream and leg for the paused session. */
  async resume(): Promise<void> {
    const rpc = this.rpc;
    const sessionId = this.sessionId;
    const audio = this.audio;
    if (rpc === null || sessionId === null || audio === null || this.state.phase !== "paused") return;
    this.attempt += 1;
    const attempt = this.attempt;
    void audio.play().catch(() => undefined);
    this.set({ phase: "resuming", note: null });
    const current = () => attempt === this.attempt && this.sessionId === sessionId && this.state.phase === "resuming";
    let stream: MediaStream | null = null;
    let leg: Leg | null = null;
    const drop = () => {
      leg?.close();
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      for (const track of stream.getAudioTracks()) track.enabled = !this.state.muted;
      if (!current()) return drop();
      leg = await this.newLeg(stream, audio);
      if (!current()) return drop();
      const { answerSdp } = await rpc.call("session.resume", { sessionId, sdp: leg.offer });
      if (!current()) return drop();
      this.stream = stream;
      this.leg = leg;
      await leg.accept(answerSdp);
      await leg.connected();
      if (!current()) return;
      this.set({ phase: "live" });
      this.heartbeat = setInterval(() => void this.beat(), ALIVE_EVERY_MS);
      await this.keepAwake(attempt);
    } catch (error) {
      if (!current()) return drop();
      if (this.leg === leg) this.leg = null;
      if (this.stream === stream) this.stream = null;
      drop();
      const { live } = await rpc.call("session.alive", { sessionId, threadId: this.focusedThread }).catch(() => ({ live: true }));
      if (!current()) return;
      if (!live) this.teardown("Voice ended while bb was away.");
      else this.set({ phase: "paused", note: `Could not pick the session up: ${talkFailure(error).replace(/^Voice could not start: /u, "")} Tap Resume to try again.` });
    }
  }

  /** The call's side of this window: the heartbeat, the leg, the microphone, the audio and the wake lock. */
  private release(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.leg?.close();
    this.leg = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.audio !== null) this.audio.srcObject = null;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  private newLeg(stream: MediaStream, audio: HTMLAudioElement): Promise<Leg> {
    return openLeg({
      stream,
      audio,
      onSpeaking: (speaking) => this.set({ speaking: { ...this.state.speaking, ...speaking } }),
      onFailed: () => {
        if (this.state.phase === "live") void this.end("the audio connection dropped");
      },
    });
  }

  /** Tells the server this window still holds the call; a session it no longer has is over here too. */
  private async beat(): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === null || this.rpc === null) return;
    try {
      const { live } = await this.rpc.call("session.alive", { sessionId, threadId: this.focusedThread });
      if (!live && this.sessionId === sessionId) this.teardown("The voice session ended.");
    } catch {
      // A missed beat is not an end; the server ends a session it stops hearing from.
    }
  }

  /** The screen stays on while talking, where the device allows it; nothing breaks where it does not. */
  private async keepAwake(attempt: number): Promise<void> {
    if (voicePlatform() === "desktop") return;
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<WakeLock> } };
      const lock = (await nav.wakeLock?.request("screen")) ?? null;
      // Ended while the lock was being granted: let it go rather than hold the screen on for nothing.
      if (attempt !== this.attempt) void lock?.release().catch(() => undefined);
      else this.wakeLock = lock;
    } catch {
      // No wake lock here; the session works without it.
    }
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.set({ muted });
  }

  async end(reason: string): Promise<void> {
    if (!this.active) return;
    const sessionId = this.sessionId;
    const attempt = this.attempt;
    this.set({ phase: "ending" });
    if (sessionId !== null) await this.rpc?.call("session.end", { sessionId, reason }).catch(() => null);
    // The server's "ended" signal can arrive first and a new Talk begin before this answer does: that new
    // session is not this End's to tear down.
    // It says why it ended, as the server's own "ended" does, so the pill stays to offer Talk again.
    if (attempt === this.attempt) this.teardown(`Voice ended: ${reason}.`);
  }

  /** What the server said on the session channel. */
  onSignal(signal: SessionSignal): void {
    if (signal.sessionId !== this.sessionId) return;
    if (signal.type === "renew") void this.renew();
    else if (signal.type === "open") {
      this.navigate?.(signal.threadId);
      if (signal.label !== undefined) this.set({ opened: { label: signal.label, ok: this.navigate !== null } });
    } else if (signal.type === "open-link") {
      let ok = false;
      try {
        ok = this.openLink?.(signal.url) ?? false;
      } catch {
        ok = false;
      }
      this.set({ opened: { label: signal.label, ok } });
    } else if (signal.type === "mute") {
      // The voice was asked to mute: the same mute as the Mute button, and never an unmute.
      if (this.state.phase === "live" && !this.state.muted) this.toggleMute();
    } else if (signal.state === "paused") this.pause(signal.reason ?? "paused", false);
    else if (signal.state === "ended") this.teardown(signal.reason === undefined ? "The voice session ended." : `Voice ended: ${signal.reason}.`);
  }

  /**
   * A second leg on the same microphone for the server's new call. The server retires the old call only once
   * this side says the new leg connected (`session.renewed`); when it cannot, the session ends here and now
   * rather than living on with no audio.
   */
  private async renew(): Promise<void> {
    const rpc = this.rpc;
    const sessionId = this.sessionId;
    const audio = this.audio;
    const stream = this.stream;
    const attempt = this.attempt;
    if (rpc === null || sessionId === null || audio === null || stream === null || this.state.phase !== "live") return;
    let next: Leg | null = null;
    const current = () => attempt === this.attempt && this.sessionId === sessionId && this.state.phase === "live";
    try {
      next = await this.newLeg(stream, audio);
      const { answerSdp } = await rpc.call("session.renew", { sessionId, sdp: next.offer });
      await next.accept(answerSdp);
      await next.connected();
      if (!current()) {
        next.close();
        return;
      }
      await rpc.call("session.renewed", { sessionId });
      // The session may have ended, and a new Talk begun, while the acknowledgement was on its way: then
      // this renewal's leg is obsolete, and it closes only itself.
      if (!current()) {
        next.close();
        return;
      }
      const old = this.leg;
      this.leg = next;
      old?.close();
    } catch {
      next?.close();
      if (current()) await this.end("the renewal could not connect");
    }
  }

  private teardown(note: string): void {
    this.attempt += 1;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.release();
    this.sessionId = null;
    this.set({ ...IDLE, note });
  }

  dismiss(): void {
    this.set({ note: null });
  }
}

/** A sentence for the pill when Talk fails. */
export function talkFailure(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError") return "Voice Pilot needs the microphone. Allow it and tap Talk again.";
  if (name === "NotFoundError") return "There is no microphone to listen with.";
  const message = error instanceof Error ? error.message : String(error);
  return `Voice could not start: ${message}`;
}

/** The window's one controller. */
export const voice = new VoiceController();
