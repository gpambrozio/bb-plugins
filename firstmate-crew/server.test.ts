import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin, { rpcContract } from "./server";
import { prepareHome } from "./server/home";
import { withMateLock } from "./server/mate";
import type { Fleet, WatchSummary } from "./shared/types";

type PendingInteraction = PluginThreadEventPayloads["interaction.pending"]["interaction"];

const tempDirs: string[] = [];
const hosts: { harness: { dispose(): Promise<void> } }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-server-"));
  tempDirs.push(dir);
  return dir;
}

async function load(options: { mateId?: string } = {}) {
  const home = await tempDir();
  const host = createFakePluginHost({ pluginId: "firstmate-crew", settings: { homeDirectory: home } });
  hosts.push(host);
  if (options.mateId !== undefined) await host.bb.storage.kv.set("mateThreadId", options.mateId);
  await plugin(host.bb);
  return { home, ...host };
}

/** How many times the server told open boards to read the fleet again. */
function fleetSignals(harness: { experimental_rpcInvalidations: (readonly string[] | null)[] }): number {
  return harness.experimental_rpcInvalidations.filter((tags) => tags?.includes("fleet") === true).length;
}

describe("server wiring", () => {
  it("registers every method of the contract, the CLI, the watch service, autocompact and notifications", async () => {
    const { harness } = await load();
    expect([...harness.registrations.rpcMethods].sort()).toEqual(Object.keys(rpcContract).sort());
    expect(harness.registrations.rpcMethods).toHaveLength(19);
    expect(harness.registrations.cli?.name).toBe("firstmate-crew");
    expect(harness.registrations.services.map((service) => service.name)).toEqual(["watches", "autocompact", "notifications"]);
  });

  it("loads a fleet with no first mate without asking bb anything", async () => {
    const { home, harness } = await load();
    const fleet = (await harness.callRpc("fleet.load", {})) as Fleet;
    expect(fleet).toMatchObject({ home, homeReady: false, mate: null, mateMissing: false, cards: [], watches: [] });
    expect(harness.sdk.calls).toEqual([]);
  });

  it("passes a handler's refusal through as its own sentence", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("mate.ask", { text: "hello" })).rejects.toThrow("No first mate aboard. Launch one in FirstMate settings.");
  });

  it("publishes the fleet only for the first mate and its children", async () => {
    const { harness } = await load({ mateId: "thr_mate" });
    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_other" }) });
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_other", parentThreadId: "thr_else" }) });
    expect(fleetSignals(harness)).toBe(0);

    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_child", parentThreadId: "thr_mate" }) });
    await harness.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_child", parentThreadId: "thr_mate" }), error: null });
    const { errors } = await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_mate" }), lastAssistantText: null });
    expect(errors).toEqual([]);
    expect(fleetSignals(harness)).toBe(3);
  });

  it("publishes the fleet when a crewmate starts waiting on an interaction or is archived", async () => {
    const { harness } = await load({ mateId: "thr_mate" });
    const child = makeThreadResponse({ id: "thr_child", parentThreadId: "thr_mate" });
    const other = makeThreadResponse({ id: "thr_other", parentThreadId: "thr_else" });
    const interaction = { id: "int_1", threadId: "thr_child", status: "pending" } as unknown as PendingInteraction;
    await harness.emitThreadEvent("interaction.pending", { thread: other, interaction });
    await harness.emitThreadEvent("thread.archived", { thread: other });
    expect(fleetSignals(harness)).toBe(0);

    const pending = await harness.emitThreadEvent("interaction.pending", { thread: child, interaction });
    const archived = await harness.emitThreadEvent("thread.archived", { thread: child });
    expect([...pending.errors, ...archived.errors]).toEqual([]);
    expect(fleetSignals(harness)).toBe(2);
  });

  it("publishes the fleet when a thread moves under the first mate or off it", async () => {
    const { harness } = await load({ mateId: "thr_mate" });
    const moved = (parentThreadId: string | null, previousParentThreadId: string | null) =>
      harness.emitThreadEvent("experimental_thread.parentChanged", {
        thread: makeThreadResponse({ id: "thr_moved", parentThreadId }),
        previousParentThreadId,
      });
    await moved("thr_else", null);
    await moved(null, "thr_else");
    expect(fleetSignals(harness)).toBe(0);

    const onto = await moved("thr_mate", "thr_else");
    const off = await moved(null, "thr_mate");
    expect([...onto.errors, ...off.errors]).toEqual([]);
    expect(fleetSignals(harness)).toBe(2);
  });

  it("refreshes a watched board every refreshSeconds, and stops when the last one leaves", async () => {
    vi.useFakeTimers();
    try {
      const { harness } = await load();
      await harness.setSettings({ refreshSeconds: 5 });
      const before = fleetSignals(harness);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fleetSignals(harness)).toBe(before);

      const unwatch = harness.experimental_watchRpc("fleet.load", { input: {} });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fleetSignals(harness)).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(fleetSignals(harness)).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fleetSignals(harness)).toBe(before + 3);

      unwatch();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fleetSignals(harness)).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes nothing while no first mate is stored", async () => {
    const { harness } = await load();
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_any" }), lastAssistantText: "done: x" });
    expect(fleetSignals(harness)).toBe(0);
  });

  it("keeps a crewmate's closing text from thread.idle, so the board does not fetch it again", async () => {
    const { harness } = await load({ mateId: "thr_mate" });
    const mate = makeThreadResponse({ id: "thr_mate", status: "idle" });
    const child = makeThreadResponse({ id: "thr_child", parentThreadId: "thr_mate", status: "idle", updatedAt: 5_000 });
    harness.sdk.stub("threads.get", () => mate);
    harness.sdk.stub("threads.list", () => [child]);
    harness.sdk.stub("threads.getPluginMetadata", () => ({}));
    harness.sdk.stub("threads.interactions.list", () => []);
    harness.sdk.stub("threads.output", () => ({ output: "working: should not be read" }));

    await harness.emitThreadEvent("thread.idle", { thread: child, lastAssistantText: "done: shipped the fix" });
    const fleet = (await harness.callRpc("fleet.load", {})) as Fleet;

    expect(fleet.cards.map((card) => card.report)).toEqual([{ state: "done", text: "shipped the fix" }]);
    expect(harness.sdk.callsTo("threads.output")).toEqual([]);
  });

  describe("the first mate's notifications", () => {
    /** bb 0.48.1's push-notifications plugin, as `bb.sdk.plugins` reaches it: levels in a map. */
    function pushPlugin(harness: Awaited<ReturnType<typeof load>>["harness"]) {
      const levels = new Map<string, string>();
      harness.sdk.stub("plugins.experimental_discoverRpc", () => [
        { pluginId: "push-notifications", method: "notifications.send", displayName: "Push", inputSchema: {}, outputSchema: {}, methodDescription: null, registrationDescription: null },
      ]);
      type Input = { threadIds: string[] } & { threadId: string; level: string };
      harness.sdk.stub("plugins.callRpc", (({ method, input }: { method: string; input: Input }) => {
        if (method === "threadNotifications.list") {
          const listed = input.threadIds.flatMap((id) => {
            const own = levels.get(id);
            return own === undefined ? [] : [[id, { own, ancestorCap: null }] as const];
          });
          return { threads: Object.fromEntries(listed) };
        }
        if (method === "threadNotifications.set") {
          levels.set(input.threadId, input.level);
          return { own: input.level, ancestorCap: null };
        }
        if (method === "notifications.send") return { ok: true, channels: ["desktop"] };
        throw new Error(`unexpected ${method}`);
      }) as never);
      harness.sdk.stub("threads.get", () => makeThreadResponse({ id: "thr_mate", status: "idle", lastReadAt: null, latestAttentionAt: 0 }));
      return levels;
    }

    function sends(harness: Awaited<ReturnType<typeof load>>["harness"]): unknown[] {
      return harness.sdk
        .callsTo("plugins.callRpc")
        .map(([args]) => args as { method: string; input: unknown })
        .filter((args) => args.method === "notifications.send")
        .map((args) => args.input);
    }

    it("asks bb nothing for a finished turn while the setting is off", async () => {
      const { harness } = await load({ mateId: "thr_mate" });
      await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_mate" }), lastAssistantText: "Done." });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.sdk.calls.filter((call) => call.path.startsWith("plugins."))).toEqual([]);
    });

    it("takes the first mate's level when switched on, sends its reply after a turn, and gives the level back when off", async () => {
      vi.useFakeTimers();
      try {
        const { harness } = await load({ mateId: "thr_mate" });
        const levels = pushPlugin(harness);
        await harness.setSettings({ mateNotifications: true });
        await vi.advanceTimersByTimeAsync(10);
        expect(levels.get("thr_mate")).toBe("input-only");

        await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_mate" }), lastAssistantText: "Captain, shipshape." });
        await harness.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: "thr_mate" }),
          lastAssistantText: "PR ready for review, captain: https://github.com/you/web/pull/42\n\n(risk: low)",
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sends(harness)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_010);
        expect(sends(harness)).toEqual([
          { title: "PR ready for review, captain: https://github.com/you/web/pull/42", body: "(risk: low)", threadId: "thr_mate" },
        ]);

        await harness.setSettings({ mateNotifications: false });
        await vi.advanceTimersByTimeAsync(10);
        expect(levels.get("thr_mate")).toBe("inherit");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows on the board why it is not sending on a bb without the push plugin's send", async () => {
      const { harness } = await load({ mateId: "thr_mate" });
      harness.sdk.stub("plugins.experimental_discoverRpc", () => []);
      harness.sdk.stub("threads.get", () => makeThreadResponse({ id: "thr_mate", status: "idle" }));
      harness.sdk.stub("threads.list", () => []);
      harness.sdk.stub("threads.getPluginMetadata", () => ({}));
      await harness.setSettings({ mateNotifications: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const fleet = (await harness.callRpc("fleet.load", {})) as Fleet;
      expect(fleet.notifications).toMatch(/bb's own notifications for the first mate are unchanged/u);
      expect(harness.sdk.callsTo("plugins.callRpc")).toEqual([]);
    });
  });

  it("checks nothing on load, and stops autocompact at once on abort", async () => {
    const { harness } = await load({ mateId: "thr_mate" });
    await harness.setSettings({ mateAutoCompact: true, crewAutoCompact: true });
    const service = harness.runService("autocompact");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.sdk.calls).toEqual([]);

    service.controller.abort();
    await service.done;
  });

  describe("autocompact's service", () => {
    /** A first mate idle for ages with a large context; `events` is how bb answers its event reads. */
    async function idleMate(events: () => Promise<unknown[]>) {
      const loaded = await load({ mateId: "thr_mate" });
      await loaded.harness.setSettings({ mateAutoCompact: true });
      const { sdk } = loaded.harness;
      sdk.stub("threads.get", () => makeThreadResponse({ id: "thr_mate", status: "idle" }));
      sdk.stub("threads.list", () => []);
      sdk.stub("threads.events.list", events);
      sdk.stub("threads.context", () => ({ usage: { usedTokens: 900_000, estimated: false, modelContextWindow: 1_000_000 } }));
      sdk.stub("threads.interactions.list", () => []);
      sdk.stub("threads.compact", () => ({ ok: true }));
      return loaded;
    }

    it("compacts an idle first mate a minute after loading", async () => {
      vi.useFakeTimers();
      try {
        const { harness } = await idleMate(async () => [{ seq: 7, createdAt: 0, type: "turn/completed" }]);
        const service = harness.runService("autocompact");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.sdk.callsTo("threads.compact")).toEqual([[{ threadId: "thr_mate" }]]);
        service.controller.abort();
        await service.done;
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops at once while another operation holds the mate lock", async () => {
      vi.useFakeTimers();
      let unlock!: () => void;
      const held = withMateLock(() => new Promise<void>((resolve) => (unlock = resolve)));
      try {
        const { harness } = await idleMate(async () => [{ seq: 7, createdAt: 0, type: "turn/completed" }]);
        const service = harness.runService("autocompact");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.sdk.callsTo("threads.context")).toHaveLength(1);

        service.controller.abort();
        let settled = false;
        void service.done.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(10);
        expect(settled).toBe(true);

        unlock();
        await held;
        await withMateLock(async () => undefined);
        expect(harness.sdk.callsTo("threads.compact")).toEqual([]);
      } finally {
        unlock();
        vi.useRealTimers();
      }
    });

    it("sends nothing once stopped while a check's read is in flight", async () => {
      vi.useFakeTimers();
      try {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const { harness } = await idleMate(async () => {
          await held;
          return [{ seq: 7, createdAt: 0, type: "turn/completed" }];
        });
        const service = harness.runService("autocompact");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.sdk.callsTo("threads.events.list")).toHaveLength(1);

        service.controller.abort();
        release();
        await vi.advanceTimersByTimeAsync(10);
        await service.done;
        expect(harness.sdk.callsTo("threads.compact")).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("runs the watches for a prepared home, toggles them in the store, and stops on abort", async () => {
    const { home, bb, harness } = await load();
    await prepareHome(home, { crewProvider: "", crewReasoning: "" });
    const service = harness.runService("watches");
    // Let the service's start reach the runner.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const summaries = (await harness.callRpc("watch.toggle", { name: "pr-watch", enabled: false })) as WatchSummary[];
    expect(summaries.find((watch) => watch.name === "pr-watch")?.enabled).toBe(false);
    expect(await bb.storage.kv.get("disabledWatches")).toEqual(["pr-watch"]);

    const again = (await harness.callRpc("watch.toggle", { name: "pr-watch", enabled: true })) as WatchSummary[];
    expect(again.find((watch) => watch.name === "pr-watch")?.enabled).toBe(true);
    expect(await bb.storage.kv.get("disabledWatches")).toEqual([]);

    service.controller.abort();
    await service.done;
    expect(await harness.callRpc("watch.toggle", { name: "pr-watch", enabled: true })).toEqual([]);
  });

  it("rebuilds the runner for a new home directory", async () => {
    const { home, harness } = await load();
    await prepareHome(home, { crewProvider: "", crewReasoning: "" });
    const service = harness.runService("watches");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(((await harness.callRpc("watch.toggle", { name: "pr-watch", enabled: true })) as WatchSummary[]).length).toBeGreaterThan(0);

    await harness.setSettings({ homeDirectory: await tempDir() });

    expect(await harness.callRpc("watch.toggle", { name: "pr-watch", enabled: true })).toEqual([]);
    expect(fleetSignals(harness)).toBe(1);
    service.controller.abort();
    await service.done;
  });
});
