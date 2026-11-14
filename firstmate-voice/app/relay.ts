// The relayed run: microphone → 24 kHz PCM16 → the plugin's `/relay`
// WebSocket on the bb server → a server-side Realtime socket, and the reply
// audio back the same way, played through Web Audio.
import { TurnMeter, analyser } from "./meter";
import type { RunOptions, RunResult } from "./webrtc";
import { speechStoppedToAudio } from "./webrtc";

const RATE = 24_000;

export function relayUrl(origin: string, model: string, ticket: string): string {
  const url = new URL("/api/v1/plugins/firstmate-voice/http/relay", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("model", model);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/** Linear resampling of one block to 24 kHz, then PCM16 little-endian, base64. */
export function toPcm16Base64(input: Float32Array, inputRate: number): string {
  const ratio = inputRate / RATE;
  const length = Math.floor(input.length / ratio);
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, input.length - 1);
    const value = input[index] + (input[next] - input[index]) * (position - index);
    view.setInt16(i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromPcm16Base64(data: string): Float32Array<ArrayBuffer> {
  const binary = atob(data);
  const samples = new Float32Array(binary.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    const low = binary.charCodeAt(i * 2);
    const high = binary.charCodeAt(i * 2 + 1);
    let value = (high << 8) | low;
    if (value >= 0x8000) value -= 0x10000;
    samples[i] = value / 0x8000;
  }
  return samples;
}

export async function runRelay(options: RunOptions): Promise<RunResult> {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const timings: Record<string, number> = {};
  const events: { t: number; type: string; info?: string }[] = [];
  const log = (type: string, info?: string) => {
    const t = now();
    events.push({ t, type, ...(info ? { info } : {}) });
    options.onEvent(t, type, info);
  };
  const result: RunResult = { path: "relay", label: options.label, model: options.model, effort: options.effort ?? "default", timings, events };
  const context = options.context;

  options.onStatus("Asking for the microphone…");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    return { ...result, error: `getUserMedia: ${(error as Error).name} ${(error as Error).message}` };
  }
  timings.getUserMediaMs = now();

  const micSource = context.createMediaStreamSource(stream);
  const playback = context.createGain();
  playback.connect(context.destination);
  const meter = new TurnMeter(analyser(context, micSource), analyser(context, playback), () => performance.now() - t0);
  // ScriptProcessor is deprecated but runs everywhere, WebKit included, with no worklet module to load.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  micSource.connect(processor);
  processor.connect(mute).connect(context.destination);

  let playAt = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const { ticket } = await options.rpc.call("relayTicket", null);
  const socket = new WebSocket(relayUrl(window.location.origin, options.model, ticket));
  let sentFrames = 0;

  const done = new Promise<void>((resolve) => {
    socket.onopen = () => {
      timings.relaySocketOpenMs = now();
      log("relay.open");
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are a voice assistant in a short connection test. Answer in one short sentence. When asked for the time, call the get_time tool and read its answer.",
          output_modalities: ["audio"],
          ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
          audio: {
            input: {
              format: { type: "audio/pcm", rate: RATE },
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
            },
            output: { format: { type: "audio/pcm", rate: RATE }, voice: "marin" },
          },
        },
      }));
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toPcm16Base64(event.inputBuffer.getChannelData(0), context.sampleRate) }));
        sentFrames += 1;
      };
      meter.start();
      options.onStatus(`Live, relayed (${options.seconds} s). Speak, e.g. "What time is it?"`);
    };
    socket.onmessage = (message) => {
      let event: Record<string, any>;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const type = String(event.type);
      if (type === "response.output_audio.delta") {
        timings.firstAudioDeltaMs ??= now();
        const samples = fromPcm16Base64(String(event.delta));
        const buffer = context.createBuffer(1, samples.length, RATE);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(playback);
        playAt = Math.max(playAt, context.currentTime + 0.02);
        source.start(playAt);
        playAt += buffer.duration;
        playing.add(source);
        source.onended = () => playing.delete(source);
        return;
      }
      if (type === "input_audio_buffer.speech_started") {
        // Barge-in: drop what is still queued.
        for (const source of playing) source.stop();
        playing.clear();
        playAt = 0;
      }
      if (type.startsWith("relay.") || type.startsWith("session.") || type.startsWith("input_audio_buffer.speech") || type === "response.created" || type === "response.done" || type === "error" || type.endsWith("transcription.completed") || type === "response.output_audio_transcript.done" || type === "response.function_call_arguments.done") {
        if (type === "relay.upstream_open") timings.upstreamOpenServerMs = Number(event.ms);
        if (type === "session.created") timings.sessionCreatedMs ??= now();
        log(type, event.transcript ?? event.response?.status ?? (event.error ? JSON.stringify(event.error) : event.message ?? event.credential));
      }
    };
    socket.onerror = () => log("relay.error");
    socket.onclose = (event) => {
      log("relay.close", `${event.code} ${event.reason}`);
      resolve();
    };
  });

  await Promise.race([done, options.stopped, new Promise((resolve) => setTimeout(resolve, options.seconds * 1000))]);
  meter.stop();
  processor.onaudioprocess = null;
  processor.disconnect();
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
  stream.getTracks().forEach((track) => track.stop());
  for (const source of playing) source.stop();
  result.sentFrames = sentFrames;
  result.contextSampleRate = context.sampleRate;
  result.turns = meter.turns;
  result.onsets = meter.onsets.map((onset) => ({ at: Math.round(onset.at), afterSpeech: onset.afterSpeech }));
  result.peaks = { local: Math.round(meter.peakLocal * 1000) / 1000, remote: Math.round(meter.peakRemote * 1000) / 1000 };
  result.serverToReply = speechStoppedToAudio(events, meter.onsets.map((onset) => onset.at));
  return result;
}
