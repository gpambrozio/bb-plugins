/**
 * FirstMate voice's server: wiring only. The app makes a WebRTC offer; `session.start` posts it to OpenAI
 * and holds the call's sideband (`server/session.ts`), with the token from codex-realtime
 * (`server/credentials.ts`) and the fleet from firstmate-crew's `voice.v1` (`server/crew-client.ts`). Thread
 * events make the live session read the brief again. The voice hooks (`server/hooks.ts`) run through the host
 * entry (`host.ts`) on the machine of the window in the call.
 */
import { defineRpcContract, type BbPluginApi, type PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { subscriptionToken } from "./server/credentials";
import { crewClient } from "./server/crew-client";
import { DebugPageSchema } from "./server/debug-log";
import { HOOK_CALL_TIMEOUT_MS, HookRunner, HookStore } from "./server/hooks";
import { openAiRealtime } from "./server/openai-port";
import { sessionHandlers } from "./server/rpc";
import { systemClock } from "./server/ports";
import { VoiceSessions, type Eagerness, type SessionSignal } from "./server/session";
import { SESSION_CHANNEL } from "./shared/channel";
import { HookCommandSchema, VoiceHooksSchema } from "./shared/hooks";
import { hostContract } from "./shared/host-contract";

const Sdp = z.string().min(10).max(20_000);
const HostId = z.string().min(1).max(200);

export const rpcContract = defineRpcContract({
  /** `hostId` and `client`: the window's machine and bb client, for where the voice hooks run. */
  "session.start": {
    input: z.object({ sdp: Sdp, hostId: HostId.nullable().optional(), client: z.enum(["desktop", "mobile", "browser"]).optional() }),
    output: z.object({ sessionId: z.string(), answerSdp: z.string() }),
  },
  "session.renew": { input: z.object({ sessionId: z.string(), sdp: Sdp }), output: z.object({ answerSdp: z.string() }) },
  /** The app's new leg at a renewal connected: the server retires the old call. */
  "session.renewed": { input: z.object({ sessionId: z.string() }), output: z.null() },
  "session.end": { input: z.object({ sessionId: z.string(), reason: z.string().max(80) }), output: z.null() },
  "session.alive": { input: z.object({ sessionId: z.string() }), output: z.object({ live: z.boolean() }) },
  "session.current": { input: z.object({}), output: z.object({ sessionId: z.string().nullable() }) },
  "mate.thread": { input: z.object({}), output: z.object({ threadId: z.string().nullable() }) },
  /** The debug view: the current session's log (or the last one's) after `afterSeq`. Local to this bb. */
  "debug.log": { input: z.object({ afterSeq: z.number().int().min(0) }), output: DebugPageSchema },
  /** The voice hooks, one command per machine by bb host id, for the settings section. */
  "hooks.list": { input: z.object({}), output: z.object({ hooks: VoiceHooksSchema }) },
  "hooks.set": { input: z.object({ hostId: HostId, command: HookCommandSchema }), output: z.object({ hooks: VoiceHooksSchema }) },
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
  // The voice hooks run on the machine whose desktop app holds the call, through the host entry there.
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const hookStore = new HookStore(bb.storage.kv, bb.log);
  const hooks = new HookRunner({
    store: hookStore,
    host: { run: (hostId, input) => hostClient.call("run", input, { hostId, timeoutMs: HOOK_CALL_TIMEOUT_MS }) },
    clock: systemClock,
    log: bb.log,
  });
  const sessions = new VoiceSessions(
    {
      realtime: openAiRealtime({ token: (signal) => subscriptionToken(bb, signal), log: bb.log }),
      crew,
      clock: systemClock,
      log: bb.log,
      publish: (signal: SessionSignal) => bb.realtime.publish(SESSION_CHANNEL, signal),
      hooks,
    },
    async () => {
      const current = await settings.get();
      return { model: current.model, effort: current.reasoning, voice: current.voice, eagerness: current.eagerness as Eagerness };
    },
  );
  bb.onDispose(() => sessions.dispose());

  const activeHosts = async () =>
    (await bb.sdk.hosts.list()).filter((host) => (host.lifecycle?.phase ?? "active") === "active").map(({ id, name }) => ({ id, name }));
  bb.rpc.register(rpcContract, sessionHandlers(sessions, crew, { store: hookStore, hosts: activeHosts }));

  // Any thread may be the first mate or one of its crew; the session reads the brief again, debounced.
  const changed = () => sessions.threadEvent();
  bb.events.on("thread.idle", changed);
  bb.events.on("thread.active", changed);
  bb.events.on("thread.failed", changed);
  bb.events.on("interaction.pending", changed);
  bb.events.on("experimental_thread.parentChanged", changed);
}
