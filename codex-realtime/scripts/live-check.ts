// A manual check that OpenAI still accepts the ChatGPT sign-in for Realtime,
// through this plugin's own code path. Not part of `npm test`: it opens one
// real session on your subscription and sends a few seconds of audio.
//
//   npm run live-check                                  # macOS: speaks a clip with `say`
//   npm run live-check -- --clip hello.wav              # 24 kHz mono 16-bit PCM WAV
//   npm run live-check -- --transcription gpt-realtime-whisper
//
// It configures the session the way Voice Mode 0.1.9 does (server-side
// WebSocket, 24 kHz PCM both ways, semantic VAD, gpt-4o-mini-transcribe input
// transcription, audio output) and reports whether the socket was accepted,
// whether your words came back as a transcript, and whether a spoken reply
// arrived. It never prints the token or any part of it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { codexAuthPath, readCodexLogin } from "../server/codex-login.ts";
import { DEFAULT_MODEL, realtimeConnection } from "../server/connection.ts";

const RATE = 24_000;
const FRAME_BYTES = (RATE * 2) / 10; // 100 ms, as Voice Mode's browser sends
const TIMEOUT_MS = 45_000;

const { values } = parseArgs({
  options: {
    clip: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    transcription: { type: "string", default: "gpt-4o-mini-transcribe" },
  },
});

function pcmFromWav(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("The clip has no WAV data chunk.");
}

function spokenClip(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "codex-realtime-live-"));
  try {
    const path = join(dir, "clip.wav");
    execFileSync("say", ["-o", path, `--data-format=LEI16@${RATE}`, "Hello. Can you hear me? Please say hi back in a few words."]);
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const login = await readCodexLogin(codexAuthPath());
const connection = realtimeConnection(login.accessToken, values.model);
const pcm = pcmFromWav(values.clip ? readFileSync(values.clip) : spokenClip());
console.log(`Opening ${connection.url} (transcription ${values.transcription}); sign-in valid until ${new Date(login.expiresAt).toISOString()}.`);

const result = {
  socketAccepted: false,
  sessionConfigured: false,
  transcript: null as string | null,
  transcriptionError: null as string | null,
  replyAudioSeconds: 0,
  replyTranscript: null as string | null,
  errors: [] as string[],
  closed: null as string | null,
};

await new Promise<void>((resolve) => {
  // Node's WebSocket takes headers in its init object, as Voice Mode uses it.
  const socket = new WebSocket(connection.url, { headers: connection.headers } as unknown as string[]);
  const send = (event: unknown) => socket.send(JSON.stringify(event));
  let transcribed = false;
  let replied = false;
  const timer = setTimeout(() => {
    result.errors.push(`no answer within ${TIMEOUT_MS / 1000} s`);
    socket.close(1000);
  }, TIMEOUT_MS);
  const finishWhenDone = () => {
    if (transcribed && replied) socket.close(1000);
  };

  socket.onopen = () => {
    result.socketAccepted = true;
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "You are a voice assistant in a quick connection test. Answer in one short sentence.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: RATE },
            transcription: { model: values.transcription },
            turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
          },
          output: { format: { type: "audio/pcm", rate: RATE }, voice: "marin" },
        },
        tools: [{ type: "function", name: "stop_agent", description: "Stop the coding agent.", parameters: { type: "object", properties: {} } }],
        tool_choice: "auto",
      },
    });
  };
  socket.onclose = (event) => {
    clearTimeout(timer);
    result.closed = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
    resolve();
  };
  socket.onmessage = async (message) => {
    const raw = typeof message.data === "string" ? message.data : await (message.data as Blob).text();
    const event = JSON.parse(raw) as Record<string, any>;
    switch (event.type) {
      case "session.updated":
        if (result.sessionConfigured) break;
        result.sessionConfigured = true;
        // The clip, then two seconds of silence so the turn detector hears it end.
        void (async () => {
          const audio = Buffer.concat([pcm, Buffer.alloc(RATE * 2 * 2)]);
          for (let offset = 0; offset < audio.length && socket.readyState === WebSocket.OPEN; offset += FRAME_BYTES) {
            send({ type: "input_audio_buffer.append", audio: audio.subarray(offset, offset + FRAME_BYTES).toString("base64") });
            await new Promise((wait) => setTimeout(wait, 100));
          }
        })();
        break;
      case "conversation.item.input_audio_transcription.completed":
        result.transcript = [result.transcript, String(event.transcript)].filter(Boolean).join(" ");
        transcribed = true;
        finishWhenDone();
        break;
      case "conversation.item.input_audio_transcription.failed":
        result.transcriptionError = JSON.stringify(event.error);
        transcribed = true;
        finishWhenDone();
        break;
      case "response.output_audio.delta":
        result.replyAudioSeconds += Buffer.from(String(event.delta), "base64").length / (RATE * 2);
        break;
      case "response.output_audio_transcript.done":
        result.replyTranscript = String(event.transcript);
        break;
      case "response.done":
        if (event.response?.status !== "completed") result.errors.push(`response ${event.response?.status}: ${JSON.stringify(event.response?.status_details)}`);
        replied = true;
        finishWhenDone();
        break;
      case "error":
        result.errors.push(`${event.error?.code ?? ""} ${event.error?.message ?? ""}`.trim());
        break;
    }
  };
});

result.replyAudioSeconds = Math.round(result.replyAudioSeconds * 10) / 10;
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.socketAccepted && result.transcript && result.replyAudioSeconds > 0 ? 0 : 1;
