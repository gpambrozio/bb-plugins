/**
 * The whole server against the SDK's fake host: what it asks bb for when a tab
 * opens and closes, what it stores, and that a reload drops ended tabs. No
 * shell is started; bb's terminals are stubs.
 */
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./server";
import { OPENING_GRACE_MS, TABS_CHANGED, type TabView } from "./shared/tabs";

afterEach(() => vi.useRealTimers());

type Session = { id: string; status: "running" | "exited"; exitCode: number | null };

function notFound(): Error {
  return Object.assign(new Error("Terminal session not found"), { status: 404 });
}

/** bb's terminal API, stubbed; `holdCreates` keeps each create waiting until the test lets it finish. */
async function start(options: { holdCreates?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  const held: (() => void)[] = [];
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
        create: async ({ id }) => {
          if (id === undefined) throw new Error("the plugin must choose the id");
          if (options.holdCreates) await new Promise<void>((resolve) => held.push(resolve));
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
  return { bb, harness, sessions, held };
}

const TERMINAL_ID = /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u;

async function tabs(harness: { callRpc(method: string, input: unknown): Promise<unknown> }): Promise<TabView[]> {
  return ((await harness.callRpc("list", {})) as { tabs: TabView[] }).tabs;
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
    const tab = (await harness.callRpc("open", { hostId: "mini", cols: 100, rows: 30 })) as TabView;
    expect(tab).toMatchObject({ hostId: "mini", hostName: "Mac mini", status: "running" });
    expect(tab.terminalId).toMatch(TERMINAL_ID);
    expect(harness.sdk.callsTo("terminals.create")).toEqual([
      [
        {
          id: tab.terminalId,
          scope: { kind: "host_path", hostId: "mini", cwd: null },
          start: { mode: "shell" },
          title: "Mac mini",
          cols: 100,
          rows: 30,
        },
      ],
    ]);
    expect(harness.realtimeSignals.map((entry) => entry.channel)).toContain(TABS_CHANGED);
    expect(await tabs(harness)).toMatchObject([{ terminalId: tab.terminalId, status: "running" }]);
  });

  it("leaves no shell without a tab when it is reloaded while bb is still opening one", async () => {
    const { harness, sessions, held } = await start({ holdCreates: true });
    const opening = harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 });
    opening.catch(() => undefined);
    await expect.poll(() => held.length).toBe(1);
    const next = (await harness.reload(plugin)).harness;
    // The new copy already has the tab, and its clean-up keeps a tab that is still opening.
    const service = next.runService("prune-ended-tabs");
    const [stored] = await tabs(next);
    expect(stored).toMatchObject({ status: "opening" });
    held[0]!();
    await opening.catch(() => undefined);
    expect([...sessions.keys()]).toEqual([stored!.terminalId]);
    expect(await tabs(next)).toMatchObject([{ terminalId: stored!.terminalId, status: "running" }]);
    // And closing it there ends the shell.
    await next.callRpc("close", { terminalId: stored!.terminalId });
    expect(sessions.get(stored!.terminalId)?.status).toBe("exited");
    service.controller.abort();
    await service.done;
  });

  it("refuses to open on a disconnected machine", async () => {
    const { harness } = await start();
    await expect(harness.callRpc("open", { hostId: "old", cols: 80, rows: 24 })).rejects.toThrow(/not connected/);
    expect(harness.sdk.callsTo("terminals.create")).toEqual([]);
  });

  it("ends the shell when its tab closes", async () => {
    const { harness, sessions } = await start();
    const tab = (await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 })) as TabView;
    await harness.callRpc("close", { terminalId: tab.terminalId });
    expect(harness.sdk.callsTo("terminals.close")).toEqual([[{ terminalId: tab.terminalId, mode: "force" }]]);
    expect(sessions.get(tab.terminalId)?.status).toBe("exited");
    expect(await harness.callRpc("list", {})).toEqual({ tabs: [] });
  });

  it("drops the tabs of ended shells when it loads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, sessions } = await start();
    const first = (await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 })) as TabView;
    const second = (await harness.callRpc("open", { hostId: "air", cols: 80, rows: 24 })) as TabView;
    sessions.delete(first.terminalId);
    vi.setSystemTime(Date.now() + OPENING_GRACE_MS);
    const next = (await harness.reload(plugin)).harness;
    const service = next.runService("prune-ended-tabs");
    await expect.poll(async () => (await tabs(next)).length).toBe(1);
    expect(await tabs(next)).toMatchObject([{ terminalId: second.terminalId }]);
    service.controller.abort();
    await service.done;
  });
});
