/**
 * Herald's server: thread events become "needs you" entries, a hidden helper
 * thread writes one sentence for each, and the app speaks it.
 *
 * Every decision lives in `server/`; this file only wires it to bb. The ports
 * over `bb.sdk` are built on first use, from a handler — never in the factory
 * body. See AGENTS.md.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import {
  DEFAULT_STORED_CONFIG,
  ENTRIES_CHANNEL,
  StoredConfigSchema,
  SummarizerConfigSchema,
  VoicesConfigSchema,
  type StoredConfig,
} from "./shared/herald";
import { SETTINGS, timeoutMsOf } from "./shared/settings";
import { bbEvents, bbHelpers, bbLiveness } from "./server/bb-ports";
import { HelperOutcomes } from "./server/helpers";
import { createHooks, type HeraldConfig } from "./server/hooks";
import { kvBackend } from "./server/kv-backend";
import { Liveness } from "./server/liveness";
import type { EventsPort, HelperPort } from "./server/ports";
import { listSayVoices, renderWithSay, sayAvailable } from "./server/say";
import { AttentionStore } from "./server/store";
import { summarize } from "./server/summarize";

export { rpcContract } from "./shared/contract";
export type { RpcContract } from "./shared/contract";

const CONFIG_KEY = "config";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const store = new AttentionStore(kvBackend(bb.storage.kv), bb.log);
  // Read before any handler is registered. The store merges anyway, so an
  // event that ever arrived mid-read would not be lost under an older entry.
  await store.load().catch((error: unknown) => {
    bb.log.error(`Could not load saved entries: ${error instanceof Error ? error.message : String(error)}`);
  });

  let events: EventsPort | null = null;
  let helpers: HelperPort | null = null;
  let liveness: Liveness | null = null;
  const eventsPort = () => (events ??= bbEvents(bb.sdk, bb.log));
  const helperPort = () => (helpers ??= bbHelpers(bb.sdk));
  const livenessOf = () => (liveness ??= new Liveness(bbLiveness(bb.sdk), bb.log));

  const outcomes = new HelperOutcomes();

  /** The summariser and voices, each half falling back to its default when unreadable. */
  async function storedConfig(): Promise<StoredConfig> {
    const raw = await bb.storage.kv.get<Partial<StoredConfig>>(CONFIG_KEY);
    const summarizer = SummarizerConfigSchema.safeParse(raw?.summarizer);
    const voices = VoicesConfigSchema.safeParse(raw?.voices);
    return {
      summarizer: summarizer.success ? summarizer.data : { ...DEFAULT_STORED_CONFIG.summarizer },
      voices: voices.success ? voices.data : { ...DEFAULT_STORED_CONFIG.voices },
    };
  }

  async function readConfig(): Promise<HeraldConfig> {
    const [values, stored] = await Promise.all([settings.get(), storedConfig()]);
    return {
      announce: {
        question: values.announceQuestions,
        plan: values.announcePlans,
        permission: values.announcePermissions,
        finished: values.announceFinished,
        error: values.announceErrors,
      },
      announceSubagents: values.announceSubagents,
      deleteHelpers: values.deleteHelpers,
      timeoutMs: timeoutMsOf(values.summaryTimeoutSeconds),
      summarizer: stored.summarizer,
    };
  }

  const hooks = createHooks({
    pluginId: bb.pluginId,
    store,
    readConfig,
    summarize: (request, config) =>
      summarize(request, {
        helpers: helperPort(),
        waitForOutcome: (helperId, timeoutMs) => outcomes.wait(helperId, timeoutMs),
        forgetHelper: (helperId) => outcomes.forget(helperId),
        providerId: config.summarizer.providerId,
        model: config.summarizer.model,
        reasoningLevel: config.summarizer.reasoningLevel,
        timeoutMs: config.timeoutMs,
        prompt: config.summarizer.prompt,
        deleteHelper: config.deleteHelpers,
        log: bb.log,
      }),
    // A getter, so bb.sdk is reached when an event needs it, not here.
    events: {
      context: (thread, options) => eventsPort().context(thread, options),
      isRunning: (threadId) => eventsPort().isRunning(threadId),
      interactionPending: (threadId, interactionId) => eventsPort().interactionPending(threadId, interactionId),
      interruptedRecently: (threadId, withinMs) => eventsPort().interruptedRecently(threadId, withinMs),
    },
    outcomes,
    publish: () => {
      try {
        bb.realtime.publish(ENTRIES_CHANNEL, { at: Date.now() });
      } catch (error) {
        // After an unload the handle is stale; the clients re-read on reconnect anyway.
        bb.log.warn(`Could not tell the app the entries changed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    log: bb.log,
  });

  bb.events.on("thread.active", ({ thread }) => hooks.active(thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => hooks.idle(thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => hooks.failed(thread, error));
  bb.events.on("interaction.pending", ({ thread, interaction }) => hooks.interactionPending(thread, interaction));
  bb.events.on("thread.archived", ({ thread }) => hooks.gone(thread));
  bb.events.on("thread.deleted", ({ thread }) => hooks.gone(thread));

  bb.rpc.register(rpcContract, {
    list: async () => ({ entries: await livenessOf().visible(store) }),
    "config.get": () => storedConfig(),
    "config.set": async (patch) => {
      const next = StoredConfigSchema.parse({ ...(await storedConfig()), ...patch });
      await bb.storage.kv.set(CONFIG_KEY, next);
      return next;
    },
    log: ({ level, message }) => {
      bb.log[level](`app: ${message}`);
      return null;
    },
    // The server's Mac renders speech with `say`; the app plays the bytes. Not
    // a Mac, or no `say`: the app hears that and uses the browser's voice.
    "speech.voices": async () => {
      const available = await sayAvailable();
      return { available, voices: available ? await listSayVoices() : [] };
    },
    "speech.render": async ({ text, voice, rate }) => {
      if (!(await sayAvailable())) throw new Error("bb does not run on a Mac here, so `say` is not available.");
      return renderWithSay(text, { voice, rate });
    },
  });

  bb.onDispose(async () => {
    hooks.dispose();
    // Each running summary's `finally` stops and puts away its helper now,
    // while bb still answers, rather than at its timeout.
    outcomes.cancelAll("Herald was reloaded before the summary was written.");
    await store.flush();
  });
}
