/**
 * FirstMate voice's server: wiring only. The app makes a WebRTC offer; `session.start` posts it to OpenAI
 * and holds the call's sideband (`server/session.ts`), with the token from codex-realtime
 * (`server/credentials.ts`) and the fleet from firstmate-crew's `voice.v1` (`server/crew-client.ts`). Thread
 * events make the live session read the brief again.
 */
import { defineRpcContract, type BbPluginApi, type PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { subscriptionToken } from "./server/credentials";
import { crewClient } from "./server/crew-client";
import { openAiRealtime } from "./server/openai-port";
import { systemClock } from "./server/ports";
import { VoiceSessions, type Eagerness, type SessionSignal } from "./server/session";
import { SESSION_CHANNEL } from "./shared/channel";

const Sdp = z.string().min(10).max(20_000);

export const rpcContract = defineRpcContract({
  "session.start": { input: z.object({ sdp: Sdp }), output: z.object({ sessionId: z.string(), answerSdp: z.string() }) },
  "session.renew": { input: z.object({ sessionId: z.string(), sdp: Sdp }), output: z.object({ answerSdp: z.string() }) },
  "session.end": { input: z.object({ sessionId: z.string(), reason: z.string().max(80) }), output: z.null() },
  "session.alive": { input: z.object({ sessionId: z.string() }), output: z.object({ live: z.boolean() }) },
  "session.current": { input: z.object({}), output: z.object({ sessionId: z.string().nullable() }) },
  "mate.thread": { input: z.object({}), output: z.object({ threadId: z.string().nullable() }) },
});

export const SETTINGS = {
  model: {
    type: "select",
    label: "Voice model",
    description: "gpt-realtime-2.1 answers best; gpt-realtime-2.1-mini is cheaper on an API key and a little faster.",
    options: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"],
    default: "gpt-realtime-2.1",
  },
  reasoning: {
    type: "select",
    label: "Reasoning",
    description: "How much the voice model thinks before it speaks. Low is the measured sweet spot; higher is slower.",
    options: ["minimal", "low", "medium", "high"],
    default: "low",
  },
  voice: {
    type: "select",
    label: "Voice",
    description: "The voice it speaks in.",
    options: ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
    default: "marin",
  },
  eagerness: {
    type: "select",
    label: "Turn taking",
    description: "How soon it answers once you stop speaking. High answers sooner and may cut in on a pause.",
    options: ["auto", "low", "medium", "high"],
    default: "auto",
  },
} satisfies Record<string, PluginSettingDescriptor>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const crew = crewClient(bb);
  const sessions = new VoiceSessions(
    {
      realtime: openAiRealtime({ token: (signal) => subscriptionToken(bb, signal), log: bb.log }),
      crew,
      clock: systemClock,
      log: bb.log,
      publish: (signal: SessionSignal) => bb.realtime.publish(SESSION_CHANNEL, signal),
    },
    async () => {
      const current = await settings.get();
      return { model: current.model, effort: current.reasoning, voice: current.voice, eagerness: current.eagerness as Eagerness };
    },
  );
  bb.onDispose(() => sessions.dispose());

  bb.rpc.register(rpcContract, {
    "session.start": ({ sdp }) => sessions.start(sdp),
    "session.renew": ({ sessionId, sdp }) => sessions.renew(sessionId, sdp),
    "session.end": async ({ sessionId, reason }) => {
      await sessions.end(sessionId, reason);
      return null;
    },
    "session.alive": async ({ sessionId }) => ({ live: sessions.alive(sessionId) }),
    "session.current": async () => ({ sessionId: sessions.current()?.id ?? null }),
    "mate.thread": async () => {
      try {
        return { threadId: await crew.mateThreadId() };
      } catch {
        // firstmate-crew missing, off, or not letting this plugin in: no Talk button on any thread.
        return { threadId: null };
      }
    },
  });

  // Any thread may be the first mate or one of its crew; the session reads the brief again, debounced.
  const changed = () => sessions.threadEvent();
  bb.events.on("thread.idle", changed);
  bb.events.on("thread.active", changed);
  bb.events.on("thread.failed", changed);
  bb.events.on("interaction.pending", changed);
  bb.events.on("experimental_thread.parentChanged", changed);
}
