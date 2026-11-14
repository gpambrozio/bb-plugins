// The WebRTC-direct run: microphone → RTCPeerConnection → OpenAI, with the
// SDP exchange done by the bb server (`startCall`), which also holds the
// sideband. The page never sees a credential.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "../server";
import { TurnMeter, analyser } from "./meter";

type Rpc = PluginRpcClient<typeof rpcContract>;

export type RunOptions = {
  rpc: Rpc;
  context: AudioContext;
  label: string;
  model: string;
  effort?: string;
  seconds: number;
  onStatus(text: string): void;
  onEvent(t: number, type: string, info?: string): void;
  /** Resolves when the person presses End; the run also ends after `seconds`. */
  stopped: Promise<void>;
  /** Lets the page send an announcement while the call is live. */
  onCallId?(callId: string | null): void;
};

export type RunResult = Record<string, unknown>;

const DC_EVENTS_KEPT = new Set([
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "conversation.item.input_audio_transcription.completed",
  "response.created",
  "response.output_audio_transcript.done",
  "response.function_call_arguments.done",
  "output_audio_buffer.started",
  "output_audio_buffer.stopped",
  "response.done",
  "error",
]);

export async function runWebRtc(options: RunOptions): Promise<RunResult> {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const timings: Record<string, number> = {};
  const events: { t: number; type: string; info?: string }[] = [];
  const firsts: Record<string, number> = {};
  const log = (type: string, info?: string) => {
    const t = now();
    events.push({ t, type, ...(info ? { info } : {}) });
    options.onEvent(t, type, info);
  };
  const result: RunResult = { path: "webrtc", label: options.label, model: options.model, effort: options.effort ?? "default", timings, events };

  options.onStatus("Asking for the microphone…");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    return { ...result, error: `getUserMedia: ${(error as Error).name} ${(error as Error).message}` };
  }
  timings.getUserMediaMs = now();

  const pc = new RTCPeerConnection();
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  const remoteGain = options.context.createGain();
  let remoteSource: MediaStreamAudioSourceNode | null = null;
  const localAnalyser = analyser(options.context, options.context.createMediaStreamSource(stream));
  const remoteAnalyser = analyser(options.context, remoteGain);
  const meter = new TurnMeter(localAnalyser, remoteAnalyser, () => performance.now() - t0);
  let callId: string | null = null;

  const cleanup = async (reason: string) => {
    meter.stop();
    options.onCallId?.(null);
    pc.close();
    stream.getTracks().forEach((track) => track.stop());
    remoteAudio.srcObject = null;
    remoteSource?.disconnect();
    if (callId) {
      const ended = await options.rpc.call("endCall", { callId, reason }).catch((error: Error) => ({ log: { error: error.message } as unknown }));
      result.serverLog = ended.log;
    }
  };

  try {
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    const channel = pc.createDataChannel("oai-events");
    pc.ontrack = (event) => {
      timings.remoteTrackMs ??= now();
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      remoteAudio.srcObject = remote;
      // Chrome feeds Web Audio from a remote stream only while an element plays it too.
      remoteSource = options.context.createMediaStreamSource(remote);
      remoteSource.connect(remoteGain);
      remoteAudio.play().then(
        () => {
          result.remoteAudioElement = "played";
        },
        (error: Error) => {
          // Fall back to Web Audio, unlocked by the tap that started the run.
          result.remoteAudioElement = `refused: ${error.name}; playing through Web Audio`;
          remoteGain.connect(options.context.destination);
        },
      );
    };
    pc.onconnectionstatechange = () => {
      log(`pc.${pc.connectionState}`);
      if (pc.connectionState === "connected") timings.peerConnectedMs ??= now();
    };
    channel.onopen = () => {
      timings.dataChannelOpenMs = now();
      log("dc.open");
    };
    channel.onmessage = (message) => {
      let event: { type?: string; transcript?: string; response?: { status?: string } };
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const type = String(event.type);
      firsts[type] ??= now();
      if (DC_EVENTS_KEPT.has(type)) log(type, event.transcript ?? event.response?.status);
    };

    options.onStatus("Creating the offer…");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    timings.offerMs = now();
    options.onStatus("SDP exchange through the bb server…");
    const sdpStart = now();
    const answer = await options.rpc.call("startCall", { sdp: offer.sdp ?? "", model: options.model, effort: options.effort as "low" | undefined, label: options.label });
    timings.sdpExchangeRoundTripMs = now() - sdpStart;
    result.serverSdpExchange = answer.log?.sdpExchange;
    if (!answer.accepted || !answer.answerSdp) {
      await cleanup("refused");
      return { ...result, error: "OpenAI refused the call", serverLog: answer.log };
    }
    callId = String(answer.log.callId);
    options.onCallId?.(callId);
    await pc.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
    meter.start();
    options.onStatus(`Live (${options.seconds} s). Speak, e.g. "What time is it?"`);
    await Promise.race([options.stopped, new Promise((resolve) => setTimeout(resolve, options.seconds * 1000))]);
    await cleanup("page ended");
  } catch (error) {
    await cleanup("page error");
    result.error = `${(error as Error).name}: ${(error as Error).message}`;
  }

  result.turns = meter.turns;
  result.onsets = meter.onsets.map((onset) => ({ at: Math.round(onset.at), afterSpeech: onset.afterSpeech }));
  result.peaks = { local: round(meter.peakLocal), remote: round(meter.peakRemote) };
  result.firstEventAt = firsts;
  result.serverToReply = speechStoppedToAudio(events, meter.onsets.map((onset) => onset.at));
  return result;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

/** For each `speech_stopped` the page saw, the next reply onset it heard. */
export function speechStoppedToAudio(events: { t: number; type: string }[], onsets: number[]) {
  return events
    .filter((event) => event.type === "input_audio_buffer.speech_stopped")
    .map((event) => {
      const onset = onsets.find((at) => at > event.t);
      return onset === undefined ? null : Math.round(onset - event.t);
    })
    .filter((value): value is number => value !== null);
}
