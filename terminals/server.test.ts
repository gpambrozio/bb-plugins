/**
 * The whole server against the SDK's fake host: what it asks bb for when a tab
 * opens and closes, what it stores, and that a reload drops ended tabs. No
 * shell is started; bb's terminals are stubs.
 */
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { TABS_CHANGED } from "./shared/tabs";

type Session = { id: string; status: "running" | "exited"; exitCode: number | null };

function notFound(): Error {
  return Object.assign(new Error("Terminal session not found"), { status: 404 });
}

async function start() {
  const sessions = new Map<string, Session>();
  let next = 1;
  const session = (id: string) => ({
    ...sessions.get(id)!,
    closeReason: null,
    cols: 80,
    rows: 24,
    createdAt: 0,
    updatedAt: 0,
    environmentId: null,
    hostId: "mini",
    initialCwd: "~",
    lastUserInputAt: null,
    threadId: null,
    title: "Mac mini",
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "terminals",
    sdk: {
      system: { config: async () => ({ primaryHostId: "mini" }) as never },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "air", name: "MacBook Air" }),
          makeHostResponse({ id: "mini", name: "Mac mini" }),
          makeHostResponse({ id: "old", name: "Old Mac", status: "disconnected" }),
        ],
      },
      terminals: {
        create: async () => {
          const id = `term_${next++}`;
          sessions.set(id, { id, status: "running", exitCode: null });
          return session(id);
        },
        get: async ({ terminalId }) => {
          if (!sessions.has(terminalId)) throw notFound();
          return session(terminalId);
        },
        close: async ({ terminalId }) => {
          if (!sessions.has(terminalId)) throw notFound();
          sessions.get(terminalId)!.status = "exited";
          return session(terminalId);
        },
      },
    },
  });
  await plugin(bb);
  return { bb, harness, sessions };
}

describe("terminals server", () => {
  it("offers the connected machines, the server's own first", async () => {
    const { harness } = await start();
    expect(await harness.callRpc("hosts", {})).toEqual({
      hosts: [
        { id: "mini", name: "Mac mini" },
        { id: "air", name: "MacBook Air" },
      ],
    });
  });

  it("opens a shell in the machine's home directory and lists it as a tab", async () => {
    const { harness } = await start();
    const tab = await harness.callRpc("open", { hostId: "mini", cols: 100, rows: 30 });
    expect(tab).toMatchObject({ terminalId: "term_1", hostId: "mini", hostName: "Mac mini", status: "running" });
    expect(harness.sdk.callsTo("terminals.create")).toEqual([
      [{ scope: { kind: "host_path", hostId: "mini", cwd: null }, start: { mode: "shell" }, title: "Mac mini", cols: 100, rows: 30 }],
    ]);
    expect(harness.realtimeSignals.map((entry) => entry.channel)).toContain(TABS_CHANGED);
    expect(await harness.callRpc("list", {})).toMatchObject({ tabs: [{ terminalId: "term_1", status: "running" }] });
  });

  it("refuses to open on a disconnected machine", async () => {
    const { harness } = await start();
    await expect(harness.callRpc("open", { hostId: "old", cols: 80, rows: 24 })).rejects.toThrow(/not connected/);
    expect(harness.sdk.callsTo("terminals.create")).toEqual([]);
  });

  it("ends the shell when its tab closes", async () => {
    const { harness, sessions } = await start();
    await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 });
    await harness.callRpc("close", { terminalId: "term_1" });
    expect(harness.sdk.callsTo("terminals.close")).toEqual([[{ terminalId: "term_1", mode: "force" }]]);
    expect(sessions.get("term_1")?.status).toBe("exited");
    expect(await harness.callRpc("list", {})).toEqual({ tabs: [] });
  });

  it("drops the tabs of ended shells when it loads again", async () => {
    const { harness, sessions } = await start();
    await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 });
    await harness.callRpc("open", { hostId: "air", cols: 80, rows: 24 });
    sessions.delete("term_1");
    const next = (await harness.reload(plugin)).harness;
    const service = next.runService("prune-ended-tabs");
    await expect.poll(async () => ((await next.callRpc("list", {})) as { tabs: unknown[] }).tabs.length).toBe(1);
    expect(await next.callRpc("list", {})).toMatchObject({ tabs: [{ terminalId: "term_2" }] });
    service.controller.abort();
    await service.done;
  });
});
