import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin, { rpcContract } from "./server";
import { prepareHome } from "./server/home";
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

function fleetSignals(harness: { realtimeSignals: { channel: string }[] }): number {
  return harness.realtimeSignals.filter((signal) => signal.channel === "fleet").length;
}

describe("server wiring", () => {
  it("registers every method of the contract, the CLI and the watch service", async () => {
    const { harness } = await load();
    expect([...harness.registrations.rpcMethods].sort()).toEqual(Object.keys(rpcContract).sort());
    expect(harness.registrations.rpcMethods).toHaveLength(18);
    expect(harness.registrations.cli?.name).toBe("firstmate-crew");
    expect(harness.registrations.services.map((service) => service.name)).toEqual(["watches"]);
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
