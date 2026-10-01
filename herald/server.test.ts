/**
 * The whole server against the SDK's fake host: a thread event becomes an
 * entry with its sentence, and the app hears about it. Nothing here talks to
 * a running bb.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "./server";
import type { AttentionEntry } from "./shared/herald";
import { ENTRIES_CHANNEL } from "./shared/herald";

const USER_THREAD = makeThreadResponse({
  id: "thr_user",
  projectId: "prj_shop",
  environmentId: "env_1",
  title: "Login fix",
  latestAttentionAt: 2,
  lastReadAt: 1,
});

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
        get: async ({ threadId }: { threadId: string }) => (threadId === USER_THREAD.id ? USER_THREAD : makeThreadResponse({ id: threadId })),
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
    expect(await harness.callRpc("config.get", {})).toEqual({ voices: { say: "", web: "" } });
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    expect(await harness.callRpc("config.get", {})).toEqual({ voices: { say: "Zoe (Premium)", web: "" } });
  });

  it("removes the entry when the thread starts a new turn", async () => {
    const { harness } = await load({ announceFinished: false });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    expect(entriesOf(await harness.callRpc("list", {}))).toHaveLength(1);
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
});
