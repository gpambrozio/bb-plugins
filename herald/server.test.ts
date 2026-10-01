/**
 * The whole server against the SDK's fake host: a thread event becomes an
 * entry, a hidden helper thread is spawned in the personal workspace, the
 * helper's own events bring its sentence back, and the app hears about it.
 * Nothing here talks to a running bb.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./server";
import { DRAIN_TIMEOUT_MS } from "./server/hooks";
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

interface LoadOptions {
  /** Runs inside every spawn, before it answers. */
  spawn?: () => Promise<unknown>;
  /** Runs inside every stop, before it answers. */
  stop?: (threadId: string) => Promise<unknown>;
  /** The hidden herald threads bb lists, by id. */
  leftovers?: () => string[];
}

/** Model summaries on unless a test says otherwise: most of these follow the helper. */
async function load(settings: Record<string, string | number | boolean> = {}, options: LoadOptions = {}) {
  const { spawn, stop, leftovers } = options;
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
        stop: async ({ threadId }: { threadId: string }) => {
          await stop?.(threadId);
          return { ok: true as const };
        },
        list: async () =>
          (leftovers?.() ?? []).map((id) => makeThreadResponse({ id, originPluginId: "herald", visibility: "hidden" })) as never,
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

  it("puts away every leftover helper before it starts one of its own (re-enabled with two still running)", async () => {
    const left = ["thr_left1", "thr_left2"];
    const { harness } = await load({}, { leftovers: () => [...left] });
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    const order = harness.sdk.calls.map((call) => call.path).filter((path) => /^threads\.(stop|delete|spawn)$/.test(path));
    expect(order).toEqual(["threads.stop", "threads.delete", "threads.stop", "threads.delete", "threads.spawn"]);
    expect(harness.sdk.callsTo("threads.delete")).toEqual([
      [{ threadId: "thr_left1", childThreadsConfirmed: true }],
      [{ threadId: "thr_left2", childThreadsConfirmed: true }],
    ]);
  });

  it("lets go of a helper whose stop hangs at unload, and the next instance puts it away before spawning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stopHangs = true;
    const alive = new Set<string>();
    const host = await load(
      {},
      {
        spawn: async () => alive.add("thr_helper"),
        // The old instance's stop never answers; later ones do.
        stop: (threadId) => (stopHangs ? new Promise(() => {}) : Promise.resolve(alive.delete(threadId))),
        leftovers: () => [...alive],
      },
    );
    await host.harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    const helper = makeThreadResponse({ id: "thr_helper", originPluginId: "herald", visibility: "hidden" });
    await host.harness.emitThreadEvent("thread.active", { thread: helper });
    await host.harness.emitThreadEvent("thread.idle", { thread: helper, lastAssistantText: '{"speech":"Done."}' });
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(alive.has("thr_helper")).toBe(true);

    // Reload: the old instance waits out its drain deadline, then lets go.
    const reloading = host.harness.lifecycle.reload(plugin).then(track);
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 100);
    const replacement = await reloading;
    stopHangs = false;

    // The next helper the replacement wants waits until the old one is gone.
    await replacement.harness.emitThreadEvent("thread.idle", { thread: { ...USER_THREAD, updatedAt: 2 }, lastAssistantText: "Again." });
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
    const order = replacement.harness.sdk.calls.map((call) => call.path).filter((path) => /^threads\.(stop|delete|spawn)$/.test(path));
    expect(order.slice(0, 3)).toEqual(["threads.stop", "threads.delete", "threads.spawn"]);
    expect(replacement.harness.sdk.callsTo("threads.stop")[0]).toEqual([{ threadId: "thr_helper" }]);
  });

  it("gives up the leftover clean-up the moment its service is aborted", async () => {
    let stops = 0;
    const { harness } = await load(
      {},
      {
        leftovers: () => ["thr_left1", "thr_left2"],
        stop: () => {
          stops += 1;
          return new Promise(() => {});
        },
      },
    );
    const service = harness.runService("leftover-helpers");
    await settle();
    expect(stops).toBe(1);
    service.controller.abort();
    // Returns at once, though the first stop never answers, and starts nothing more.
    await service.done;
    await settle();
    expect(stops).toBe(1);
    expect(harness.sdk.callsTo("threads.delete")).toEqual([]);
  });

  it("puts the leftovers away at the first spawn when an aborted service left them", async () => {
    let first = true;
    const { harness } = await load(
      {},
      {
        leftovers: () => ["thr_left1"],
        stop: () => {
          if (!first) return Promise.resolve();
          first = false;
          return new Promise(() => {});
        },
      },
    );
    const service = harness.runService("leftover-helpers");
    await settle();
    service.controller.abort();
    await service.done;
    await harness.emitThreadEvent("thread.idle", { thread: USER_THREAD, lastAssistantText: "Done." });
    await settle();
    const order = harness.sdk.calls.map((call) => call.path).filter((path) => /^threads\.(stop|delete|spawn)$/.test(path));
    expect(order).toEqual(["threads.stop", "threads.stop", "threads.delete", "threads.spawn"]);
  });

  it("does nothing when its service is aborted before it starts", async () => {
    const { harness } = await load({}, { leftovers: () => ["thr_left1"] });
    const service = harness.runService("leftover-helpers");
    service.controller.abort();
    await service.done;
    await settle();
    expect(harness.sdk.callsTo("threads.stop")).toEqual([]);
  });

  it("stops a helper whose spawn answers after a reload began, before the reload finishes", async () => {
    let spawned: () => void = () => {};
    const host = await load({}, { spawn: () => new Promise<void>((resolve) => (spawned = resolve)) });
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
