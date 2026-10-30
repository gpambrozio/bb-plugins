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
import {
  DEFAULT_STORED_CONFIG,
  ENTRIES_CHANNEL,
  RecentHistoryLimitSchema,
  SentenceToolSchema,
  StoredConfigSchema,
  VoicesConfigSchema,
  type StoredConfig,
} from "./shared/herald";
import { customCommandSeed, sentenceSettingsOf, SETTINGS } from "./shared/settings";
import { CHOICES_CHANNEL, effectiveChoice } from "./shared/thread-choice";
import { bbEvents, bbLiveness, bbNames, bbPush, bbThreadChoices } from "./server/bb-ports";
import { SentenceHistory } from "./server/history";
import { createHooks, type HeraldConfig } from "./server/hooks";
import { kvBackend } from "./server/kv-backend";
import { Liveness } from "./server/liveness";
import type { EventsPort, LivenessPort, NamesPort, PushPort } from "./server/ports";
import { PushTakeover } from "./server/push";
import { withNames } from "./server/recent";
import { announceDrained, onOtherDrained } from "./server/reload-signal";
import { listSayVoices, renderWithSay, sayAvailable } from "./server/say";
import { AttentionStore } from "./server/store";
import { ThreadChoices } from "./server/thread-choices";
import { SentenceWriter } from "./server/writer";

export { rpcContract } from "./shared/contract";
export type { RpcContract } from "./shared/contract";

const CONFIG_KEY = "config";

/**
 * How long after a load a pending entry left by an earlier instance is kept
 * before it is dropped, when no reload drain says that instance is gone. A
 * drain takes seconds; a cold start never sends one.
 */
export const ABANDONED_AFTER_MS = 60_000;

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const store = new AttentionStore(kvBackend(bb.storage.kv), bb.log);
  // Read before any handler is registered. The store merges anyway, so an
  // event that ever arrived mid-read would not be lost under an older entry.
  await store.load().catch((error: unknown) => {
    bb.log.error(`Could not load saved entries: ${error instanceof Error ? error.message : String(error)}`);
  });
  // A sentence an earlier instance was still writing is not coming: its tool
  // died with it. Such an entry is dropped, never promoted — but only once
  // that instance has had its last word. On a reload that is its drain signal
  // (bb loads this instance before disposing the old one, which may still
  // withdraw or land the entry meanwhile); on a cold start no signal ever
  // comes, so a timer stands in for it. This instance's own runs are left alone.
  const instance = randomUUID();
  const dropAbandoned = () => {
    if (store.dropPending(hooks.inFlightEventIds())) publish();
  };
  // Levels too wait for the earlier instance: it gives every thread's bb
  // notification level back as it unloads, and a mute set meanwhile would be
  // undone under this one. A cold start waits the same minute.
  const settledFromBefore = () => {
    dropAbandoned();
    push.setReady();
    void settings
      .get()
      .then((values) => (values.pushSentences ? undefined : push.giveBackAll()))
      .catch((error: unknown) => bb.log.error(`Could not check Herald's push notifications at load: ${reasonText(error)}`));
  };
  const abandonedTimer = setTimeout(settledFromBefore, ABANDONED_AFTER_MS);
  const stopListening = onOtherDrained(bb.pluginId, instance, () => {
    store
      .reconcile()
      .then(() => {
        // Only a read that succeeded stands in for the timer; a failed one
        // leaves it to drop what the old instance left, a minute on.
        clearTimeout(abandonedTimer);
        settledFromBefore();
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
  let names: NamesPort | null = null;
  let choices: ThreadChoices | null = null;
  let facts: LivenessPort | null = null;
  let pushPort: PushPort | null = null;
  const eventsPort = () => (events ??= bbEvents(bb.sdk, bb.log));
  const factsPort = () => (facts ??= bbLiveness(bb.sdk));
  const pushPortOf = () => (pushPort ??= bbPush(bb.sdk, bb.log));
  /** Saves are chained: two partial writes at once must both land. */
  let configWrites: Promise<unknown> = Promise.resolve();
  const livenessOf = () => (liveness ??= new Liveness(factsPort(), bb.log));
  const namesPort = () => (names ??= bbNames(bb.sdk));
  const choicesOf = () => (choices ??= new ThreadChoices(bbThreadChoices(bb.sdk)));

  function publishOn(channel: string, what: string): void {
    try {
      bb.realtime.publish(channel, { at: Date.now() });
    } catch (error) {
      // After an unload the handle is stale; the clients re-read on reconnect anyway.
      bb.log.warn(`Could not tell the app ${what} changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function publish(): void {
    publishOn(ENTRIES_CHANNEL, "the entries");
  }

  /** The stored configuration, each part falling back to its default when unreadable. */
  async function storedConfig(): Promise<StoredConfig> {
    const raw = await bb.storage.kv.get<Partial<StoredConfig>>(CONFIG_KEY);
    const voices = VoicesConfigSchema.safeParse(raw?.voices);
    const tool = SentenceToolSchema.safeParse(raw?.sentenceTool);
    const limit = RecentHistoryLimitSchema.safeParse(raw?.recentHistoryLimit);
    const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
    return {
      voices: voices.success ? voices.data : { ...DEFAULT_STORED_CONFIG.voices },
      sentenceTool: tool.success ? tool.data : DEFAULT_STORED_CONFIG.sentenceTool,
      sentenceCommand: text(raw?.sentenceCommand, DEFAULT_STORED_CONFIG.sentenceCommand),
      sentencePrompt: text(raw?.sentencePrompt, DEFAULT_STORED_CONFIG.sentencePrompt),
      recentHistoryLimit: limit.success ? limit.data : DEFAULT_STORED_CONFIG.recentHistoryLimit,
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
      push: values.pushSentences,
    };
  }

  // Every port is reached on first use, from a handler: bb.sdk is not for the factory body.
  const push = new PushTakeover({
    port: {
      unavailable: () => pushPortOf().unavailable(),
      ancestors: (threadId) => pushPortOf().ancestors(threadId),
      descendants: (threadId) => pushPortOf().descendants(threadId),
      ownLevels: (threadIds) => pushPortOf().ownLevels(threadIds),
      setOwnLevel: (threadId, level) => pushPortOf().setOwnLevel(threadId, level),
      defaults: () => pushPortOf().defaults(),
      send: (notification) => pushPortOf().send(notification),
    },
    kv: bb.storage.kv,
    enabled: async () => (await settings.get()).pushSentences,
    facts: (threadId) => factsPort().facts(threadId),
    interactionPending: (threadId, interactionId) => eventsPort().interactionPending(threadId, interactionId),
    log: bb.log,
  });
  settings.onChange((next, prev) => {
    if (next.pushSentences === prev.pushSentences) return;
    // On, nothing is swept: each thread is taken over as Herald next handles it.
    if (next.pushSentences) push.switchedOn();
    else void push.switchedOff();
  });

  /**
   * A thread's choice changed from its menu: its bb level follows now rather
   * than at its next event. One thread at a time, and only with the switch on
   * — a selection can name 200. Threads that inherit the choice follow at
   * their next event.
   */
  function syncPushOf(threadIds: readonly string[]): void {
    void (async () => {
      if (!(await settings.get()).pushSentences) return;
      for (const threadId of threadIds) {
        await push.decide(
          threadId,
          async () => {
            const [config, inputs, ancestors] = await Promise.all([
              readConfig(),
              choicesOf().inputsOf(threadId),
              pushPortOf().ancestors(threadId),
            ]);
            return effectiveChoice(inputs, (ancestors ?? []).length > 0, config.announceSubagents).choice;
          },
          null,
        );
      }
    })().catch((error: unknown) => bb.log.error(`Could not bring bb's notification levels in line with a new choice: ${reasonText(error)}`));
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
    // Read per event, so a choice made in the thread menu applies to the next one.
    choiceOf: (thread) => choicesOf().inputsOf(thread.id),
    publish,
    // The tool runs here, on the bb server's machine; see AGENTS.md.
    writeSentence: (command, prompt) => writer.write(command, prompt),
    remember: (threadId, item) => history.append(threadId, item),
    push,
    log: bb.log,
  });

  bb.events.on("thread.active", ({ thread }) => hooks.active(thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => hooks.idle(thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => hooks.failed(thread, error));
  bb.events.on("interaction.pending", ({ thread, interaction }) => hooks.interactionPending(thread, interaction));
  bb.events.on("thread.archived", ({ thread }) => {
    hooks.gone(thread);
    // Given back, so an unarchived thread notifies as it did before Herald.
    void push.forget(thread.id, true);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    hooks.gone(thread);
    void push.forget(thread.id, false);
    // Archived threads keep their history; a deleted one is gone for good.
    // An archived thread has no entry left for `gone` to publish about, so
    // the Herald page hears of its sentences going from here.
    void history.remove(thread.id).then(publish);
  });

  bb.rpc.register(rpcContract, {
    list: async () => ({ entries: await livenessOf().visible(store) }),
    "history.list": ({ threadId }) => history.list(threadId).then((items) => ({ items })),
    "history.recent": async () => {
      const { recentHistoryLimit } = await storedConfig();
      return { items: await withNames(await history.recent(recentHistoryLimit), namesPort(), bb.log) };
    },
    "choices.list": async ({ threadIds }) => ({ threads: Object.fromEntries(await choicesOf().inputs(threadIds)) }),
    // A thread's choice also decides its descendants', so every open menu
    // re-reads every row it shows rather than this one alone.
    // They hear of it as soon as it is saved, before the read-back, which
    // may fail on its own.
    "choices.set": async ({ threadId, choice }) => {
      await choicesOf().set(threadId, choice);
      publishOn(CHOICES_CHANNEL, "a thread's choice");
      syncPushOf([threadId]);
      return choicesOf().inputsOf(threadId);
    },
    // Told once for the whole selection, and also when only some were saved.
    "choices.setMany": async ({ threadIds, choice }) => {
      try {
        await choicesOf().setMany(threadIds, choice);
      } finally {
        publishOn(CHOICES_CHANNEL, "several threads' choice");
        syncPushOf(threadIds);
      }
      return null;
    },
    "push.status": () => push.status(),
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
        // An open Herald page re-reads its history at the new length.
        if (saved.recentHistoryLimit !== current.recentHistoryLimit) publish();
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
    clearTimeout(abandonedTimer);
    // Hooks first, so a tool killed next cannot land a sentence; the store
    // then freezes with the entry still pending, for the next load to settle.
    const owedPushes = hooks.dispose();
    await writer.dispose();
    // A sentence that will not come goes out as the plain one; then every
    // level Herald muted is given back — bb has no separate hook for a
    // disable or a removal, and a reload takes them over again lazily.
    await owedPushes;
    await push.close();
    await store.shutdown();
    await history.flush();
    announceDrained(bb.pluginId, instance);
  });
}
