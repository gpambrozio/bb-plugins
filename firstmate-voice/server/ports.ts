/**
 * The narrow slices of the outside world the voice session needs, so the session, the policy, the brief
 * sync and the announcer are tested against plain fakes (`testing/`): OpenAI's Realtime API, firstmate-crew's
 * `voice.v1`, and time. `server.ts` builds the real ones.
 */
import type { VoiceBrief, VoiceCard, VoiceReply, VoiceSent } from "../shared/crew-voice";

/** One server event of a Realtime call, as the sideband receives it. */
export type RealtimeEvent = Record<string, unknown> & { type: string };

/** The sideband: a server-side socket on one WebRTC call. */
export interface Sideband {
  send(event: Record<string, unknown>): void;
  close(): void;
}

export interface SidebandHandlers {
  onOpen(): void;
  onEvent(event: RealtimeEvent): void;
  /** `expected` is true when this side closed it. */
  onClose(info: { code: number; reason: string; expected: boolean }): void;
}

export interface RealtimePort {
  /** Posts the device's SDP offer with the session config; answers the SDP answer and the call id, or throws a sentence. */
  createCall(input: { sdp: string; session: Record<string, unknown>; signal?: AbortSignal }): Promise<{ callId: string; answerSdp: string }>;
  /** Ends the call from the server; a call that has already ended is not an error. */
  hangup(callId: string): Promise<void>;
  openSideband(callId: string, handlers: SidebandHandlers): Sideband;
}

/** firstmate-crew's `voice.v1`, called as this plugin. A refusal rejects with the callee's sentence and code. */
export interface CrewPort {
  brief(): Promise<VoiceBrief>;
  card(ref: string): Promise<VoiceCard>;
  reply(): Promise<VoiceReply>;
  ask(words: string): Promise<VoiceSent>;
  answer(ref: string, words: string): Promise<VoiceSent>;
  press(ref: string, etag: string): Promise<VoiceSent>;
  mateThreadId(): Promise<string | null>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A refusal from `voice.v1`, by its RPC code: `forbidden`, `not_found`, `conflict`, or another failure. */
export function refusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
