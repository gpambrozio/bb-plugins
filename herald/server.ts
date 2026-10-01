/**
 * Herald's server: thread events become "needs you" entries, a hidden helper
 * thread writes one sentence for each, and the app speaks it.
 *
 * Every decision lives in `server/`; this file only wires it to bb. The ports
 * over `bb.sdk` are built on first use, from a handler — never in the factory
 * body. See AGENTS.md.
 */
import { randomUUID } from "node:crypto";

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
import { HelperOwnership } from "./server/helper-ownership";
import { announceDrained, handOverHelper, onHelperHandedOver, onOtherDrained } from "./server/reload-signal";
import { listSayVoices, renderWithSay, sayAvailable } from "./server/say";
import { sharedSlots } from "./server/slots";
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
  // The instance a reload replaces may still be writing; read again once it says it is done.
  const instance = randomUUID();
  const stopListening = onOtherDrained(bb.pluginId, instance, () => {
    store
      .reconcile()
      .then(() => publish())
      .catch((error: unknown) => {
        bb.log.error(`Could not re-read saved entries after a reload: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  let events: EventsPort | null = null;
  let helpers: HelperPort | null = null;
  let liveness: Liveness | null = null;
  const eventsPort = () => (events ??= bbEvents(bb.sdk, bb.log));
  const helperPort = () => (helpers ??= bbHelpers(bb.sdk, bb.pluginId));
  const livenessOf = () => (liveness ??= new Liveness(bbLiveness(bb.sdk), bb.log));

  const outcomes = new HelperOutcomes();
  const startedAt = Date.now();
  /** Two helpers alive at once, counted across this instance and any it replaced. */
  const slots = sharedSlots(bb.pluginId, 2);
  /** The helpers this instance is responsible for; see `server/helper-ownership.ts`. */
  const ownership = new HelperOwnership(helperPort, (helperId) => handOverHelper(bb.pluginId, instance, helperId));

  /** Puts away a helper no running summary is waiting on: one handed over, or one left behind. */
  async function retireLeftover(helperId: string): Promise<void> {
    const port = helperPort();
    try {
      await port.stop(helperId);
    } catch (error) {
      bb.log.warn(`Could not stop leftover summary helper ${helperId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if ((await settings.get()).deleteHelpers) await port.delete(helperId);
      else await port.archive(helperId);
    } catch (error) {
      bb.log.warn(`Could not put away leftover summary helper ${helperId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A handed-over helper still holds the old instance's slot; it is released
  // when `done` tells the old instance this one has put the helper away.
  const stopTakingHelpers = onHelperHandedOver(bb.pluginId, instance, (helperId, done) => {
    void retireLeftover(helperId).finally(done);
  });

  function publish(): void {
    try {
      bb.realtime.publish(ENTRIES_CHANNEL, { at: Date.now() });
    } catch (error) {
      // After an unload the handle is stale; the clients re-read on reconnect anyway.
      bb.log.warn(`Could not tell the app the entries changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
      modelSummaries: values.modelSummaries,
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
        helpers: ownership,
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
    slots,
    publish,
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

  // Helpers no instance put away — a process that stopped mid-summary, a
  // handover nobody was there to take (the plugin was disabled). Only ones
  // created before this instance started, so none of its own is touched.
  bb.background.service("leftover-helpers", {
    async start(signal) {
      try {
        const leftovers = await ownership.listLeftovers(startedAt);
        for (const helperId of leftovers) {
          if (signal.aborted) return;
          if (ownership.owns(helperId)) continue;
          // A leftover may still be running a turn: it takes a slot until it is put away.
          const release = await slots.acquire();
          try {
            await retireLeftover(helperId);
          } finally {
            release();
          }
        }
        if (leftovers.length > 0) bb.log.info(`Put away ${leftovers.length} leftover summary helpers.`);
      } catch (error) {
        bb.log.warn(`Could not look for leftover summary helpers: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  bb.onDispose(async () => {
    stopListening();
    stopTakingHelpers();
    // Every running summary's wait fails now — and so does one whose spawn has
    // not answered yet — so its `finally` stops and puts its helper away while
    // bb still answers.
    outcomes.cancelAll("Herald was reloaded before the summary was written.");
    const drained = await hooks.drain();
    // Whatever is still out past the deadline — a hung spawn or stop — is
    // handed to the live instance, never left to this one's stale SDK.
    ownership.release();
    if (!drained) bb.log.warn("Handed the summary helpers still running at unload to the next instance.");
    await store.shutdown();
    announceDrained(bb.pluginId, instance);
  });
}
