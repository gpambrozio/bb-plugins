/**
 * Herald's server: thread events become "needs you" entries, each with one
 * plain sentence, and the app speaks it.
 *
 * Every decision lives in `server/`; this file only wires it to bb. The ports
 * over `bb.sdk` are built on first use, from a handler — never in the factory
 * body. Herald starts no threads of its own. See AGENTS.md.
 */
import { randomUUID } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { DEFAULT_STORED_CONFIG, ENTRIES_CHANNEL, SentenceToolSchema, StoredConfigSchema, VoicesConfigSchema, type StoredConfig } from "./shared/herald";
import { customCommandSeed, sentenceSettingsOf, SETTINGS } from "./shared/settings";
import { bbEvents, bbLiveness } from "./server/bb-ports";
import { SentenceHistory } from "./server/history";
import { createHooks, type HeraldConfig } from "./server/hooks";
import { kvBackend } from "./server/kv-backend";
import { Liveness } from "./server/liveness";
import type { EventsPort } from "./server/ports";
import { announceDrained, onOtherDrained } from "./server/reload-signal";
import { listSayVoices, renderWithSay, sayAvailable } from "./server/say";
import { AttentionStore } from "./server/store";
import { SentenceWriter } from "./server/writer";

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
  // A sentence the instance before this one was still writing is not coming:
  // its tool died with it. The plain sentence stands — promoted now, for a
  // server that starts fresh, and again below once a replaced instance has
  // drained, for whatever it left pending then. Neither promotion is a claim:
  // the drained instance's last word (a withdrawal, a sentence that landed)
  // still wins at the read, and this instance's own runs are left alone.
  store.settlePending();
  // The instance a reload replaces may still be writing; read again once it says it is done.
  const instance = randomUUID();
  const stopListening = onOtherDrained(bb.pluginId, instance, () => {
    store
      .reconcile()
      .then(() => {
        store.settlePending(hooks.inFlightEventIds());
        publish();
      })
      .catch((error: unknown) => {
        bb.log.error(`Could not re-read saved entries after a reload: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  const writer = new SentenceWriter(bb.log);
  const history = new SentenceHistory(bb.storage.kv, bb.log);

  let events: EventsPort | null = null;
  let liveness: Liveness | null = null;
  const eventsPort = () => (events ??= bbEvents(bb.sdk, bb.log));
  /** Saves are chained: two partial writes at once must both land. */
  let configWrites: Promise<unknown> = Promise.resolve();
  const livenessOf = () => (liveness ??= new Liveness(bbLiveness(bb.sdk), bb.log));

  function publish(): void {
    try {
      bb.realtime.publish(ENTRIES_CHANNEL, { at: Date.now() });
    } catch (error) {
      // After an unload the handle is stale; the clients re-read on reconnect anyway.
      bb.log.warn(`Could not tell the app the entries changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The stored configuration, each part falling back to its default when unreadable. */
  async function storedConfig(): Promise<StoredConfig> {
    const raw = await bb.storage.kv.get<Partial<StoredConfig>>(CONFIG_KEY);
    const voices = VoicesConfigSchema.safeParse(raw?.voices);
    const tool = SentenceToolSchema.safeParse(raw?.sentenceTool);
    const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
    return {
      voices: voices.success ? voices.data : { ...DEFAULT_STORED_CONFIG.voices },
      sentenceTool: tool.success ? tool.data : DEFAULT_STORED_CONFIG.sentenceTool,
      sentenceCommand: text(raw?.sentenceCommand, DEFAULT_STORED_CONFIG.sentenceCommand),
      sentencePrompt: text(raw?.sentencePrompt, DEFAULT_STORED_CONFIG.sentencePrompt),
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
      sentence: sentenceSettingsOf(values.writeWithModel, stored),
    };
  }

  const hooks = createHooks({
    store,
    readConfig,
    // A getter, so bb.sdk is reached when an event needs it, not here.
    events: {
      context: (thread, options) => eventsPort().context(thread, options),
      interruptedRecently: (threadId, withinMs) => eventsPort().interruptedRecently(threadId, withinMs),
      interactionPending: (threadId, interactionId) => eventsPort().interactionPending(threadId, interactionId),
    },
    publish,
    // The tool runs here, on the bb server's machine; see AGENTS.md.
    writeSentence: (command, prompt) => writer.write(command, prompt),
    remember: (threadId, item) => history.append(threadId, item),
    log: bb.log,
  });

  bb.events.on("thread.active", ({ thread }) => hooks.active(thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => hooks.idle(thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => hooks.failed(thread, error));
  bb.events.on("interaction.pending", ({ thread, interaction }) => hooks.interactionPending(thread, interaction));
  bb.events.on("thread.archived", ({ thread }) => hooks.gone(thread));
  bb.events.on("thread.deleted", ({ thread }) => {
    hooks.gone(thread);
    // Archived threads keep their history; a deleted one is gone for good.
    history.remove(thread.id).catch(() => {});
  });

  bb.rpc.register(rpcContract, {
    list: async () => ({ entries: await livenessOf().visible(store) }),
    "history.list": ({ threadId }) => history.list(threadId).then((items) => ({ items })),
    "config.get": () => storedConfig(),
    // Any part of the stored configuration; the rest is kept. When the tool
    // becomes "custom" with nothing written yet, the command of the tool
    // selected before is filled in, so the user edits a working line.
    "config.set": (next) => {
      const write = configWrites.then(async () => {
        const current = await storedConfig();
        const merged = StoredConfigSchema.parse({ ...current, ...next });
        const seed = customCommandSeed(current, merged);
        const saved = seed === null ? merged : { ...merged, sentenceCommand: seed };
        await bb.storage.kv.set(CONFIG_KEY, saved);
        return saved;
      });
      // A failed save must not wedge the ones after it.
      configWrites = write.catch(() => {});
      return write;
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
    stopListening();
    // Hooks first, so a tool killed next cannot land a sentence; the store
    // then freezes with the entry still pending, for the next load to settle.
    hooks.dispose();
    await writer.dispose();
    await store.shutdown();
    await history.flush();
    announceDrained(bb.pluginId, instance);
  });
}
