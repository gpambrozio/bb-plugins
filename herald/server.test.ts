/**
 * The whole server against the SDK's fake host: a thread event becomes an
 * entry with its sentence, and the app hears about it. Nothing here talks to
 * a running bb.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, { ABANDONED_AFTER_MS } from "./server";
import { announceDrained } from "./server/reload-signal";
import type { AttentionEntry } from "./shared/herald";
import { DEFAULT_STORED_CONFIG, ENTRIES_CHANNEL, TOOL_COMMANDS } from "./shared/herald";

/** A "tool" that answers with whether the prompt carried the request: real process, no model. */
const ECHO_TOOL = `"${process.execPath}" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(s.includes('Fix the login bug')?'Login fix is done; nothing is left for you.':'No request seen.'))"`;
const SLOW_TOOL = `"${process.execPath}" -e "setTimeout(()=>{},60000)"`;

const USER_THREAD = makeThreadResponse({
  id: "thr_user",
  projectId: "prj_shop",
  environmentId: "env_1",
  title: "Login fix",
  latestAttentionAt: 2,
  lastReadAt: 1,
});

const OTHER_THREAD = makeThreadResponse({ id: "thr_other", projectId: "prj_shop", title: "Docs", latestAttentionAt: 2, lastReadAt: 1 });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function load(settings: Record<string, string | number | boolean> = {}) {
  const host = createFakePluginHost({
    pluginId: "herald",
    settings,
    sdk: {
      projects: { get: async () => ({ id: "prj_shop", name: "Shop" }) as never },
      environments: { get: async () => ({ id: "env_1", path: "/Users/me/shop" }) as never },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          [USER_THREAD, OTHER_THREAD].find((known) => known.id === threadId) ?? makeThreadResponse({ id: threadId }),
        promptHistory: async () =>
          [{ id: "m1", createdAt: 1, input: [{ type: "text", text: "Fix the login bug", mentions: [] }] }] as never,
        interactions: { list: async () => [], get: async () => ({ status: "pending" }) as never },
      },
    },
  });
  await plugin(host.bb);
  live.push(host);
  return host;
}

/** Every host a test made: instances of one plugin share in-process channels, so each test disposes its own. */
const live: Array<{ harness: { lifecycle: { dispose(): Promise<void> } } }> = [];

function track<T extends { harness: { lifecycle: { dispose(): Promise<void> } } }>(host: T): T {
  live.push(host);
  return host;
}

function entriesOf(result: unknown): AttentionEntry[] {
  return (result as { entries: AttentionEntry[] }).entries;
}

describe("herald server", () => {
  afterEach(async () => {
    await Promise.all(live.splice(0).map((host) => host.harness.lifecycle.dispose().catch(() => {})));
  });

  it("announces a finished turn with its plain sentence, tells the app, and starts no thread", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry).toMatchObject({
      threadId: "thr_user",
      reason: "finished",
      projectName: "Shop",
      lastRequest: "Fix the login bug",
      summary: { status: "ready", text: "Login fix finished. I fixed auth.ts." },
    });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL)).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("reaches bb for nothing while it loads", async () => {
    const { harness } = await load();
    await settle();
    expect(harness.sdk.calls).toEqual([]);
  });

  it("lists a switched-off kind without announcing it", async () => {
    const { harness } = await load({ announceQuestions: false });
    await harness.emitThreadEvent("interaction.pending", {
      thread: USER_THREAD,
      interaction: {
        createdAt: 1,
        id: "int_1",
        payload: { kind: "user_question", questions: [{ id: "q", prompt: "Ship it?", allowFreeText: true, multiSelect: false }] },
        providerId: "claude-code",
        providerRequestId: "r",
        providerThreadId: "p",
        resolution: null,
        resolvedAt: null,
        status: "pending",
        statusReason: null,
        threadId: USER_THREAD.id,
        turnId: "turn",
      },
    });
    await settle();
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry).toMatchObject({ reason: "question", headline: "Ship it?", summary: { status: "off" } });
  });

  it("keeps the voices it is given, and falls back to defaults", async () => {
    const { harness } = await load();
    expect(await harness.callRpc("config.get", {})).toEqual(DEFAULT_STORED_CONFIG);
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    expect(await harness.callRpc("config.get", {})).toEqual({ ...DEFAULT_STORED_CONFIG, voices: { say: "Zoe (Premium)", web: "" } });
  });

  it("keeps the sentence when the thread starts a new turn, and when the user has read the thread", async () => {
    const { harness } = await load({ announceFinished: false });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
    // USER_THREAD is read (lastReadAt 1 < latestAttentionAt 2 says unread; flip it) — still listed.
    await harness.emitThreadEvent("thread.active", { thread: { ...USER_THREAD, lastReadAt: 10 } });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
  });

  it("takes back a sentence still being written when the thread starts a new turn", async () => {
    const { harness } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    expect(entriesOf(await harness.callRpc("list", {}))).toEqual([]);
  });

  it("keeps its entries across a reload, even one written while the reload ran", async () => {
    const host = await load({ announceFinished: false });
    // No wait for the write to land: the replacement loads first, and reads
    // storage again once the old instance says it has drained.
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    const reloaded = track(await host.harness.lifecycle.reload(plugin));
    await settle();
    expect(entriesOf(await reloaded.harness.callRpc("list", {})).map((entry) => entry.threadId)).toEqual(["thr_user"]);
  });

  it("has the configured tool write the sentence, listing the plain one while it does", async () => {
    const { harness } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: ECHO_TOOL });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    const [pending] = entriesOf(await harness.callRpc("list", {}));
    expect(pending?.summary).toEqual({ status: "pending", fallback: "Login fix finished. I fixed auth.ts." });
    await vi.waitFor(async () => {
      const [entry] = entriesOf(await harness.callRpc("list", {}));
      expect(entry?.summary).toEqual({ status: "ready", text: "Login fix is done; nothing is left for you." });
    });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL)).toHaveLength(2);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("drops, unspoken, a sentence the instance before it was still writing — a question answered meanwhile included", async () => {
    const host = await load({ writeWithModel: true });
    await host.harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await host.harness.emitThreadEvent("interaction.pending", {
      thread: USER_THREAD,
      interaction: {
        createdAt: 1,
        id: "int_1",
        payload: { kind: "user_question", questions: [{ id: "q", prompt: "Ship it?", allowFreeText: true, multiSelect: false }] },
        providerId: "claude-code",
        providerRequestId: "r",
        providerThreadId: "p",
        resolution: null,
        resolvedAt: null,
        status: "pending",
        statusReason: null,
        threadId: USER_THREAD.id,
        turnId: "turn",
      },
    });
    await settle();
    expect(entriesOf(await host.harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    // The replacement never promotes what it did not write: nothing to announce, nothing to resurrect.
    const reloaded = track(await host.harness.lifecycle.reload(plugin));
    await settle();
    expect(entriesOf(await reloaded.harness.callRpc("list", {}))).toEqual([]);
    expect(reloaded.harness.sdk.callsTo("threads.interactions.get")).toEqual([]);
  });

  it("starts the custom command from the tool selected before, in the answer to the save itself", async () => {
    const { harness } = await load();
    await harness.callRpc("config.set", { sentenceTool: "codex" });
    expect(await harness.callRpc("config.set", { sentenceTool: "custom" })).toMatchObject({ sentenceTool: "custom", sentenceCommand: TOOL_COMMANDS.codex });
    // Cleared while on custom: stays blank.
    expect(await harness.callRpc("config.set", { sentenceCommand: "" })).toMatchObject({ sentenceCommand: "" });
  });

  it("keeps the voices when the model settings are saved, and the other way round", async () => {
    const { harness } = await load();
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    await harness.callRpc("config.set", { sentencePrompt: "Say: {{headline}}" });
    expect(await harness.callRpc("config.get", {})).toEqual({
      ...DEFAULT_STORED_CONFIG,
      voices: { say: "Zoe (Premium)", web: "" },
      sentencePrompt: "Say: {{headline}}",
    });
  });

  it("keeps each thread's past sentences for its panel, and forgets a deleted thread", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "And the tests pass." });
    await settle();
    const { items } = (await harness.callRpc("history.list", { threadId: "thr_user" })) as { items: Array<{ text: string }> };
    expect(items.map((item) => item.text)).toEqual(["Login fix finished. And the tests pass.", "Login fix finished. I fixed auth.ts."]);
    await harness.emitThreadEvent("thread.deleted", { thread: USER_THREAD });
    await settle();
    expect(await harness.callRpc("history.list", { threadId: "thr_user" })).toEqual({ items: [] });
  });

  it("lists the newest sentences of every thread for the Herald page, as many as configured", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    await harness.emitThreadEvent("thread.idle", { thread: OTHER_THREAD, lastAssistantText: "Wrote the guide." });
    await settle();
    await harness.emitThreadEvent("thread.active", { thread: USER_THREAD });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "And the tests pass." });
    await settle();
    type Recent = { items: Array<{ threadId: string; threadTitle: string | null; projectName: string | null; threadExists: boolean; text: string }> };
    const all = (await harness.callRpc("history.recent", {})) as Recent;
    expect(all.items.map(({ threadId, threadTitle, projectName, threadExists, text }) => ({ threadId, threadTitle, projectName, threadExists, text }))).toEqual([
      { threadId: "thr_user", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Login fix finished. And the tests pass." },
      { threadId: "thr_other", threadTitle: "Docs", projectName: "Shop", threadExists: true, text: "Docs finished. Wrote the guide." },
      { threadId: "thr_user", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Login fix finished. I fixed auth.ts." },
    ]);

    const signals = harness.realtimeSignals.length;
    expect(await harness.callRpc("config.set", { recentHistoryLimit: 2 })).toMatchObject({ recentHistoryLimit: 2 });
    // An open page re-reads at its new length.
    expect(harness.realtimeSignals.slice(signals).map((signal) => signal.channel)).toEqual([ENTRIES_CHANNEL]);
    expect(((await harness.callRpc("history.recent", {})) as Recent).items.map((item) => item.threadId)).toEqual(["thr_user", "thr_other"]);

    await harness.emitThreadEvent("thread.deleted", { thread: USER_THREAD });
    await settle();
    expect(((await harness.callRpc("history.recent", {})) as Recent).items.map((item) => item.threadId)).toEqual(["thr_other"]);
  });

  it("lists 20 by default, refuses a length out of bounds, and reads an unreadable one as the default", async () => {
    const { bb, harness } = await load();
    expect(await harness.callRpc("config.get", {})).toMatchObject({ recentHistoryLimit: 20 });
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 0 })).rejects.toThrow();
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 51 })).rejects.toThrow();
    await expect(harness.callRpc("config.set", { recentHistoryLimit: 2.5 })).rejects.toThrow();
    await harness.callRpc("config.set", { recentHistoryLimit: 50 });
    expect(await harness.callRpc("config.get", {})).toMatchObject({ recentHistoryLimit: 50 });
    // A configuration saved before the setting existed has none.
    const { recentHistoryLimit: _, ...older } = DEFAULT_STORED_CONFIG;
    await bb.storage.kv.set("config", older);
    expect(await harness.callRpc("config.get", {})).toEqual(DEFAULT_STORED_CONFIG);
  });

  it("still drops what the instance before left when the read after its drain fails once", async () => {
    const host = await load({ writeWithModel: true });
    await host.harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The replacement's second read of storage — the one after the drain — fails.
      const reloaded = track(
        await host.harness.lifecycle.reload((bb) => {
          const kv = bb.storage.kv;
          const list = kv.list.bind(kv);
          let reads = 0;
          kv.list = async (prefix?: string) => {
            reads += 1;
            if (reads === 2) throw new Error("kv away");
            return list(prefix);
          };
          return plugin(bb);
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(entriesOf(await reloaded.harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(ABANDONED_AFTER_MS);
      expect(entriesOf(await reloaded.harness.callRpc("list", {}))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both of two saves made at once", async () => {
    const { harness } = await load();
    await Promise.all([harness.callRpc("config.set", { sentenceTool: "codex" }), harness.callRpc("config.set", { sentencePrompt: "Say: {{headline}}" })]);
    expect(await harness.callRpc("config.get", {})).toMatchObject({ sentenceTool: "codex", sentencePrompt: "Say: {{headline}}" });
  });

  it("does not give up on a sentence it is itself still writing when the instance before it drains", async () => {
    const { harness, bb } = await load({ writeWithModel: true });
    await harness.callRpc("config.set", { sentenceTool: "custom", sentenceCommand: SLOW_TOOL });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
    announceDrained(bb.pluginId, "the-instance-before");
    await settle();
    expect(entriesOf(await harness.callRpc("list", {}))[0]?.summary.status).toBe("pending");
  });
});
