/**
 * The whole server against the SDK's fake host, for the push notification
 * when a job starts failing: the setting, the call to bb's Push notifications
 * plugin, and what a reload remembers. The host entry is a stub answering
 * `health`; nothing here talks to a running bb or sends a real notification.
 */
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import type { FailingJob } from "./shared/jobs";

const backup: FailingJob = { id: "backup", name: "Backup", exitCode: 1 };
const sync: FailingJob = { id: "sync", name: "Sync notes", exitCode: 3 };

/** Lets the queued push work finish. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function start(options: { pushFails?: boolean } = {}) {
  const state = { failing: [] as FailingJob[] };
  const pushes: unknown[] = [];
  // Given at creation rather than stubbed afterwards, so the instance a reload makes has them too.
  const { bb, harness } = createFakePluginHost({
    pluginId: "launchd-jobs",
    sdk: {
      system: { config: async () => ({ primaryHostId: "mini" }) as never },
      hosts: { list: async () => [makeHostResponse({ id: "mini", name: "Mac mini" })] },
      plugins: {
        callRpc: async (args) => {
          if (options.pushFails) throw new Error("plugin push-notifications is not enabled");
          pushes.push({ pluginId: args.pluginId, method: args.method, input: args.input });
          return { ok: true, channels: ["desktop"] } as never;
        },
      },
    },
    experimental_callHostRpc: ({ method }) => {
      if (method !== "health") throw new Error(`unexpected host call ${method}`);
      return { supported: true, jobCount: 2, failing: state.failing };
    },
  });
  await plugin(bb);
  let current = harness;
  return {
    state,
    pushes,
    get harness() {
      return current;
    },
    /** One count, as the minute-by-minute service takes it. */
    async count() {
      await current.callRpc("health", { refresh: true });
      await settle();
    },
    async reload() {
      current = (await current.reload(plugin)).harness;
    },
  };
}

describe("the push when a job starts failing", () => {
  it("is off by default", async () => {
    const server = await start();

    await server.count();
    server.state.failing = [backup];
    await server.count();

    expect(server.pushes).toEqual([]);
  });

  it("once turned on, sends one notification through Push notifications when a job starts failing, and none while it stays failing", async () => {
    const server = await start();
    await server.count();
    await server.harness.setSettings({ notifyOnFailure: true });

    server.state.failing = [backup];
    await server.count();
    await server.count();

    expect(server.pushes).toEqual([
      {
        pluginId: "push-notifications",
        method: "notifications.send",
        input: { title: "Backup failed on Mac mini", body: "Its last run exited with code 1." },
      },
    ]);
  });

  it("does not announce jobs already failing when it is turned on", async () => {
    const server = await start();
    server.state.failing = [backup];
    await server.count();

    await server.harness.setSettings({ notifyOnFailure: true });
    await server.count();
    expect(server.pushes).toEqual([]);

    server.state.failing = [backup, sync];
    await server.count();
    expect(server.pushes).toHaveLength(1);
  });

  it("remembers across a reload what it already announced, and announces a job again once it recovered and failed again", async () => {
    const server = await start();
    await server.count();
    await server.harness.setSettings({ notifyOnFailure: true });
    server.state.failing = [backup];
    await server.count();
    expect(server.pushes).toHaveLength(1);

    await server.reload();
    await server.count();
    expect(server.pushes).toHaveLength(1);

    server.state.failing = [];
    await server.count();
    server.state.failing = [backup];
    await server.count();
    expect(server.pushes).toHaveLength(2);
  });

  it("logs once and keeps counting when Push notifications cannot be reached", async () => {
    const server = await start({ pushFails: true });
    await server.count();
    await server.harness.setSettings({ notifyOnFailure: true });

    server.state.failing = [backup];
    await server.count();
    server.state.failing = [backup, sync];
    await server.count();

    const health = (await server.harness.callRpc("health", { refresh: false })) as { failing: unknown[] };
    expect(health.failing).toHaveLength(2);
    const warnings = server.harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("push notification"));
    expect(warnings).toHaveLength(1);
  });
});
