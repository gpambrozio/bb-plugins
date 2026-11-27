/**
 * Voice Pilot's server: wiring only. The app makes a WebRTC offer; `session.start` posts it to OpenAI and
 * holds the call's sideband (`server/session.ts`), with the bearer from the API key setting or codex-realtime
 * (`server/credentials.ts`), and the tools over bb's SDK (`server/bb-port.ts`, `server/tools.ts`). Thread
 * events become announcements in a live session. The voice hooks (`server/hooks.ts`) run through the host
 * entry (`host.ts`) on the machine of the window in the call.
 */
import { defineRpcContract, type BbPluginApi, type PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { sdkBb } from "./server/bb-port";
import { CONNECTIONS, CREDENTIAL_PLUGIN, callToken } from "./server/credentials";
import { DebugPageSchema } from "./server/debug-log";
import { HOOK_CALL_TIMEOUT_MS, HOOK_STATUS_TIMEOUT_MS, HookRunner, machineHookStatuses } from "./server/hooks";
import { DEFAULT_INSTRUCTIONS, ownInstructions } from "./server/instructions";
import { openAiRealtime } from "./server/openai-port";
import { PromptEdits } from "./server/prompt-edits";
import { promptHandlers, sessionHandlers } from "./server/rpc";
import { systemClock } from "./server/ports";
import { VoiceSessions, type AnnounceLevel, type Eagerness, type SessionSignal } from "./server/session";
import { SESSION_CHANNEL } from "./shared/channel";
import { HookFileStatusSchema, type HookEvent } from "./shared/hooks";
import { hostContract } from "./shared/host-contract";
import { PROMPT_EDIT_TAG, promptContract } from "./shared/prompt-edit";

const Sdp = z.string().min(10).max(20_000);
const HostId = z.string().min(1).max(200);
const ThreadId = z.string().min(1).max(200).nullable();

export const rpcContract = defineRpcContract({
  /** The voice's staged edit of its own instructions: read, apply (as staged or tweaked), reject. App only. */
  ...promptContract,
  /** `hostId` and `client`: the window's machine and bb client, for where the voice hooks run; `threadId`: the thread on its screen. */
  "session.start": {
    input: z.object({
      sdp: Sdp,
      hostId: HostId.nullable().optional(),
      client: z.enum(["desktop", "mobile", "browser"]).optional(),
      threadId: ThreadId.optional(),
    }),
    output: z.object({ sessionId: z.string(), answerSdp: z.string() }),
  },
  "session.renew": { input: z.object({ sessionId: z.string(), sdp: Sdp }), output: z.object({ answerSdp: z.string() }) },
  /** The app's new leg at a renewal connected: the server retires the old call. */
  "session.renewed": { input: z.object({ sessionId: z.string() }), output: z.null() },
  "session.end": { input: z.object({ sessionId: z.string(), reason: z.string().max(80) }), output: z.null() },
  /** bb left the phone's screen: the session is paused, not ended (`paused` false when it is not live or not a phone's). */
  "session.pause": { input: z.object({ sessionId: z.string(), reason: z.string().max(80) }), output: z.object({ paused: z.boolean() }) },
  /** The phone is back: a new offer for the paused session's next call. */
  "session.resume": { input: z.object({ sessionId: z.string(), sdp: Sdp }), output: z.object({ answerSdp: z.string() }) },
  "session.alive": { input: z.object({ sessionId: z.string(), threadId: ThreadId.optional() }), output: z.object({ live: z.boolean() }) },
  /** The thread on the screen of the window holding the call changed. */
  "session.focus": { input: z.object({ sessionId: z.string(), threadId: ThreadId }), output: z.null() },
  "session.current": { input: z.object({}), output: z.object({ sessionId: z.string().nullable() }) },
  /** The debug view: the current session's log (or the last one's) after `afterSeq`. Local to this bb. */
  "debug.log": { input: z.object({ afterSeq: z.number().int().min(0) }), output: DebugPageSchema },
  /**
   * Whether each of bb's machines has a voice hook file, for the settings section; null for a machine that
   * did not answer. Never what is in it. Nothing sets a hook: the owner writes the file on the machine.
   */
  "hooks.status": {
    input: z.object({}),
    output: z.object({ machines: z.array(z.object({ hostId: z.string(), name: z.string(), status: HookFileStatusSchema.nullable() })) }),
  },
});

export const SETTINGS = {
  connection: {
    type: "select",
    label: "Connection",
    description:
      "How calls reach OpenAI. Auto uses the API key when one is set, else the ChatGPT subscription through the codex-realtime plugin (which must list voice-pilot in its Plugins that may use the sign-in).",
    options: [...CONNECTIONS],
    experimental_optionLabels: { auto: "Auto", "api-key": "OpenAI API key", chatgpt: "ChatGPT subscription (codex-realtime)" },
    default: "auto",
  },
  openaiApiKey: {
    type: "string",
    label: "OpenAI API key",
    description: "Kept as a bb secret on the server, never sent to the app. Voice time is billed to this key.",
    secret: true,
  },
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
  announce: {
    type: "select",
    label: "Announce",
    description: "What it tells you while you talk: a thread waiting on you and a thread that failed, and threads finishing their turn.",
    options: ["talked-to", "all", "off"],
    experimental_optionLabels: {
      "talked-to": "Waiting, failed, and finished threads you messaged by voice",
      all: "Waiting, failed, and every finished root thread",
      off: "Nothing",
    },
    default: "talked-to",
  },
  instructions: {
    type: "string",
    label: "Instructions",
    description:
      "How the voice behaves, greeting included: what it says when a session starts. Clear it to go back to the default. Rules about questions, approvals and what is never done by voice are added after it and cannot be changed here.",
    experimental_multiline: true,
    default: DEFAULT_INSTRUCTIONS,
  },
} satisfies Record<string, PluginSettingDescriptor>;

const EAGERNESS = new Set(["auto", "low", "medium", "high"]);
const ANNOUNCE = new Set(["talked-to", "all", "off"]);

/** Hidden threads (plugins' helpers) are never announced. */
function hidden(thread: unknown): boolean {
  return (thread as { visibility?: unknown } | null)?.visibility === "hidden";
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  // The voice hooks run on the machine whose desktop app holds the call, through the host entry there.
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const hookHost = {
    status: (hostId: string) => hostClient.call("status", {}, { hostId, timeoutMs: HOOK_STATUS_TIMEOUT_MS }),
    run: (hostId: string, input: { event: HookEvent; reason: string | null }) => hostClient.call("run", input, { hostId, timeoutMs: HOOK_CALL_TIMEOUT_MS }),
  };
  const hooks = new HookRunner({ host: hookHost, clock: systemClock, log: bb.log });
  const credentials = {
    settings: async () => {
      const current = await settings.get();
      return { connection: current.connection, openaiApiKey: current.openaiApiKey };
    },
    callCodexRealtime: (signal?: AbortSignal) =>
      bb.sdk.plugins.callRpc({ pluginId: CREDENTIAL_PLUGIN, method: "realtimeConnection", input: {}, outputSchema: z.unknown(), signal }),
  };
  // The voice's edits of its own instructions wait here for the owner; applying one writes the setting,
  // which each session reads as it starts.
  const prompts = new PromptEdits({
    kv: bb.storage.kv,
    instructions: {
      get: async () => ownInstructions((await settings.get()).instructions),
      set: async (text) => {
        await settings.experimental_set({ instructions: text });
      },
    },
    clock: systemClock,
    log: bb.log,
    changed: () => void bb.rpc.experimental_invalidate([PROMPT_EDIT_TAG]),
  });
  const sessions = new VoiceSessions(
    {
      realtime: openAiRealtime({ token: (signal) => callToken(credentials, signal), log: bb.log }),
      bb: sdkBb(bb.sdk),
      clock: systemClock,
      log: bb.log,
      publish: (signal: SessionSignal) => bb.realtime.publish(SESSION_CHANNEL, signal),
      hooks,
      stageInstructions: (request) => prompts.stage(request),
    },
    async () => {
      const current = await settings.get();
      return {
        model: current.model,
        effort: current.reasoning,
        voice: current.voice,
        eagerness: (EAGERNESS.has(current.eagerness) ? current.eagerness : "auto") as Eagerness,
        instructions: current.instructions,
        announce: (ANNOUNCE.has(current.announce) ? current.announce : "talked-to") as AnnounceLevel,
      };
    },
  );
  bb.onDispose(() => sessions.dispose());

  const activeHosts = async () =>
    (await bb.sdk.hosts.list()).filter((host) => (host.lifecycle?.phase ?? "active") === "active").map(({ id, name }) => ({ id, name }));
  bb.rpc.register(rpcContract, {
    ...sessionHandlers(sessions, { hosts: activeHosts, statuses: (hosts) => machineHookStatuses(hosts, hookHost, systemClock) }),
    ...promptHandlers(prompts),
  });

  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    if (!hidden(thread)) sessions.news("waiting", thread.id, interaction.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    if (!hidden(thread)) sessions.news("failed", thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!hidden(thread)) sessions.news("finished", thread.id, undefined, lastAssistantText);
  });
}
