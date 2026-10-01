/**
 * The whole server against the SDK's fake host: a thread event becomes an
 * entry, a hidden helper thread is spawned in the personal workspace, the
 * helper's own events bring its sentence back, and the app hears about it.
 * Nothing here talks to a running bb.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "./server";
import { DRAIN_TIMEOUT_MS } from "./server/hooks";
import { resetSharedSlotsForTests } from "./server/slots";
import type { AttentionEntry } from "./shared/herald";
import { DEFAULT_SUMMARIZER, ENTRIES_CHANNEL } from "./shared/herald";

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

/** Model summaries on unless a test says otherwise: most of these follow the helper. */
async function load(settings: Record<string, string | number | boolean> = {}, spawn?: () => Promise<unknown>) {
  const host = createFakePluginHost({
    pluginId: "herald",
    settings: { modelSummaries: true, ...settings },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_main" }) as never },
      projects: {
        // As bb does: the personal project is left out unless asked for.
        list: async (args?: { includePersonal?: boolean }) =>
          [
            { id: "prj_shop", kind: "standard", name: "Shop" },
            ...(args?.includePersonal === true ? [{ id: "prj_personal", kind: "personal", name: "Personal" }] : []),
          ] as never,
        get: async () => ({ id: "prj_shop", name: "Shop" }) as never,
      },
      environments: { get: async () => ({ id: "env_1", path: "/Users/me/shop" }) as never },
      threads: {
        spawn: async () => {
          await spawn?.();
          return makeThreadResponse({ id: "thr_helper", originPluginId: "herald", visibility: "hidden" });
        },
        stop: async () => ({ ok: true as const }),
        delete: async () => ({ ok: true as const }),
        archive: async () => ({ threads: [] }) as never,
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
  beforeEach(() => resetSharedSlotsForTests("herald"));
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(live.splice(0).map((host) => host.harness.lifecycle.dispose().catch(() => {})));
  });

  it("summarises a finished turn through a hidden helper and tells the app", async () => {
    const { harness } = await load();

    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed **auth.ts**." });
    await settle();

    const spawns = harness.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]?.[0] as Record<string, unknown>;
    expect(spawn).toMatchObject({
      projectId: "prj_personal",
      environment: { type: "host", hostId: "host_main", workspace: { type: "personal" } },
      providerId: DEFAULT_SUMMARIZER.providerId,
      model: DEFAULT_SUMMARIZER.model,
      visibility: "hidden",
      title: "Herald summary",
      pluginMetadata: { role: "summarizer", threadId: "thr_user" },
    });
    expect(spawn.prompt).toContain('Thread: "Login fix", in the project "Shop" (folder shop).');
    expect(spawn.prompt).toContain("What the user last asked for: Fix the login bug");
    // Not a child of the thread it describes: a child would notify its parent.
    expect(spawn.parentThreadId).toBeUndefined();

    const pending = entriesOf(await harness.callRpc("list", {}));
    expect(pending.map((entry) => entry.summary.status)).toEqual(["pending"]);

    // The helper's own events — hidden from the sidebar, not from plugins.
    const helper = makeThreadResponse({ id: "thr_helper", originPluginId: "herald", visibility: "hidden" });
    await harness.emitThreadEvent("thread.active", { thread: helper });
    await harness.emitThreadEvent("thread.idle", {
      thread: helper,
      lastAssistantText: '```json\n{"speech": "Login fix is done; nothing is left for you."}\n```',
    });
    await settle();

    const ready = entriesOf(await harness.callRpc("list", {}));
    expect(ready).toHaveLength(1);
    expect(ready[0]?.summary).toEqual({
      status: "ready",
      text: "Login fix is done; nothing is left for you.",
      model: `${DEFAULT_SUMMARIZER.providerId}/${DEFAULT_SUMMARIZER.model}`,
    });
    // The helper is stopped, then deleted, and no entry is made for it.
    expect(harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_helper" }]]);
    expect(harness.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "thr_helper", childThreadsConfirmed: true }]]);
    expect(ready.map((entry) => entry.threadId)).toEqual(["thr_user"]);

    expect(harness.realtimeSignals.filter((signal) => signal.channel === ENTRIES_CHANNEL).length).toBeGreaterThanOrEqual(2);
  });

  it("archives the helper instead when the user keeps helpers", async () => {
    const { harness } = await load({ deleteHelpers: false });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    const helper = makeThreadResponse({ id: "thr_helper", originPluginId: "herald", visibility: "hidden" });
    await harness.emitThreadEvent("thread.failed", { thread: helper, error: "rate limited" });
    await settle();
    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_helper" }]]);
    expect(harness.sdk.callsTo("threads.delete")).toEqual([]);
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry?.summary).toMatchObject({ status: "failed", error: "rate limited", fallback: "Login fix finished. Done." });
  });

  it("lists a switched-off kind without spawning a helper", async () => {
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
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry).toMatchObject({ reason: "question", headline: "Ship it?", summary: { status: "off" } });
  });

  it("keeps the summariser and voices it is given, and falls back to defaults", async () => {
    const { harness } = await load();
    expect(await harness.callRpc("config.get", {})).toEqual({
      summarizer: DEFAULT_SUMMARIZER,
      voices: { say: "", web: "" },
    });
    await harness.callRpc("config.set", { voices: { say: "Zoe (Premium)", web: "" } });
    expect(await harness.callRpc("config.get", {})).toMatchObject({
      summarizer: DEFAULT_SUMMARIZER,
      voices: { say: "Zoe (Premium)", web: "" },
    });
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

  it("says the plain sentence and spawns no helper unless model summaries are switched on", async () => {
    const { harness } = await load({ modelSummaries: false });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "I fixed auth.ts." });
    await settle();
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    const [entry] = entriesOf(await harness.callRpc("list", {}));
    expect(entry?.summary).toEqual({ status: "ready", text: "Login fix finished. I fixed auth.ts.", model: "plain" });
  });

  it("has the new instance put away a helper whose spawn answers only after the unload deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let spawned: () => void = () => {};
      const host = await load({}, () => new Promise<void>((resolve) => (spawned = resolve)));
      await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
      await vi.advanceTimersByTimeAsync(0);
      const reloading = host.harness.lifecycle.reload(plugin).then(track);
      // The spawn hangs past the drain deadline; unload gives up waiting and returns.
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 100);
      const replacement = await reloading;
      expect(host.harness.sdk.callsTo("threads.stop")).toEqual([]);
      // Then the spawn answers, through the old instance, whose SDK is stale by now:
      // the replacement puts the helper away with its own.
      spawned();
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(host.harness.sdk.callsTo("threads.stop")).toEqual([]);
      expect(replacement.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_helper" }]]);
      expect(replacement.harness.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "thr_helper", childThreadsConfirmed: true }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts away leftover helpers from before it started, and none of its own", async () => {
    const host = await load();
    host.harness.sdk.stub("threads.list", async () => [
      makeThreadResponse({ id: "thr_old", originPluginId: "herald", visibility: "hidden", createdAt: 1 }),
      makeThreadResponse({ id: "thr_fresh", originPluginId: "herald", visibility: "hidden", createdAt: Date.now() + 60_000 }),
    ]);
    const service = host.harness.runService("leftover-helpers");
    await settle();
    expect(host.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_old" }]]);
    expect(host.harness.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "thr_old", childThreadsConfirmed: true }]]);
    service.controller.abort();
    await service.done;
  });

  it("stops a helper whose spawn answers after a reload began, before the reload finishes", async () => {
    let spawned: () => void = () => {};
    const host = await load({}, () => new Promise<void>((resolve) => (spawned = resolve)));
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    let reloaded = false;
    const reloading = host.harness.lifecycle.reload(plugin).then((replacement) => {
      track(replacement);
      reloaded = true;
    });
    await settle();
    // The old instance cannot finish unloading while its helper is unaccounted for.
    expect(reloaded).toBe(false);
    spawned();
    await reloading;
    expect(host.harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_helper" }]]);
    expect(host.harness.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "thr_helper", childThreadsConfirmed: true }]]);
  });
});
