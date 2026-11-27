// The server through the SDK's fake host: bb's dispatch hook and Claude Code's environment resolver
// together, over a small fake of bb's threads and their metadata.
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { MACHINE_CHECKS_SERVICE } from "./server/machine-checks";
import { SPAWNED_SETTING } from "./shared/settings";

const PLUGIN_ID = "code-mode";
const LAUNCHER = "/data/plugins/code-mode/host-data/bb-claude-code-mode";
const HOST = "host_mini";
const OTHER_HOST = "host_work_laptop";
const PROJECT = "proj_a";
const PROJECT_NAME = "Acme Web";

type Thread = ReturnType<typeof makeThreadResponse>;

async function setup(options: { settings?: Record<string, string>; hostReady?: boolean | (() => boolean); storedConfig?: unknown } = {}) {
  const threads = new Map<string, Thread>();
  const metadata = new Map<string, Record<string, unknown>>();
  const turns = new Set<string>();
  const hostCalls: string[] = [];
  let loading = true;
  const projectNames = new Map<string, string>([
    [PROJECT, PROJECT_NAME],
    ["proj_other_checkout", PROJECT_NAME],
    ["proj_billing", "Billing API"],
  ]);
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings: options.settings,
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          const name = projectNames.get(projectId);
          if (!name) throw new Error(`no project ${projectId}`);
          return { id: projectId, name };
        },
        list: async () => [...projectNames].map(([id, name]) => ({ id, name })),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`no thread ${threadId}`);
          return thread;
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: readonly string[] }) => ({
          threads: threadIds.filter((id) => metadata.has(id)).map((threadId) => ({ threadId, metadata: metadata.get(threadId)! })),
        }),
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
          const next = { ...(metadata.get(threadId) ?? {}), ...set };
          metadata.set(threadId, next);
          return next;
        },
        events: {
          list: async ({ threadId }: { threadId: string }) => (turns.has(threadId) ? [{ type: "turn/completed" }] : []),
        },
      },
    } as never,
    experimental_callHostRpc: (call) => {
      // As bb does: no host calls while the plugin's factory is still loading.
      if (loading) throw new Error("host plugin calls are unavailable during factory registration; call from a handler, service, or timer");
      hostCalls.push(call.hostId);
      const ready = typeof options.hostReady === "function" ? options.hostReady() : options.hostReady !== false;
      return ready ? { ok: true, path: LAUNCHER } : { ok: false, reason: "Windows" };
    },
  });
  if (options.storedConfig !== undefined) await bb.storage.kv.set("config", options.storedConfig);
  await plugin(bb);
  // Anything the factory left running finishes here, still counted as loading.
  await new Promise((resolve) => setTimeout(resolve, 0));
  loading = false;

  function thread(id: string, overrides: Partial<Thread> = {}): Thread {
    const made = makeThreadResponse({ id, projectId: PROJECT, providerId: "claude-code", status: "pending", createdAt: Date.now() + 1, ...overrides });
    threads.set(id, made);
    return made;
  }

  async function send(threadId: string, overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) {
    const hook = harness.registrations.hooks["message.dispatch"]!;
    const current = threads.get(threadId)!;
    const context: MessageDispatchHookContext = makeMessageDispatchHookContext({
      attempt: "start-turn",
      initiator: "user",
      senderThreadId: null,
      parentThreadId: null,
      experimental_submission: null,
      ...overrides,
      thread: { ...current, ...overrides.thread },
      project: { id: current.projectId, name: projectNames.get(current.projectId) ?? "Unknown", ...overrides.project },
      host: overrides.host === undefined ? { id: HOST } : overrides.host,
      requestedExecution: { providerId: "claude-code", model: "claude-opus-5-5", ...overrides.requestedExecution },
    });
    return hook(context);
  }

  const codeModeSend = { experimental_submission: { pluginId: PLUGIN_ID, data: { codeMode: true } } };

  const resolve = (threadId: string | null, hostId = HOST) => harness.behavior.resolveProviderEnv("claude-code", { threadId, projectId: PROJECT, hostId });

  /** After the first message: the thread is no longer pending. */
  function started(threadId: string) {
    threads.set(threadId, { ...threads.get(threadId)!, status: "idle" });
    turns.add(threadId);
  }

  async function turnOnHost(hostId = HOST) {
    await harness.behavior.callRpc("config.setHost", { hostId, on: true });
  }

  return { bb, harness, thread, send, resolve, started, turnOnHost, metadata, hostCalls, codeModeSend, turns };
}

const WRAPPER_ENTRY = [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: LAUNCHER, reason: "Code Mode was chosen for this thread" }];

describe("Send in Code Mode", () => {
  it("puts the thread in Code Mode for good: every start, resume and turn gets the wrapper", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_cm");
    expect(await t.send("thr_cm", t.codeModeSend)).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_cm")?.codeMode).toMatchObject({ codeMode: "on", reason: "chosen in the Send menu" });
    expect(await t.resolve("thr_cm")).toEqual(WRAPPER_ENTRY);
    t.started("thr_cm");
    expect(await t.send("thr_cm")).toEqual({ action: "proceed" });
    expect(await t.resolve("thr_cm")).toEqual(WRAPPER_ENTRY);
  });

  it("leaves an ordinary thread alone", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_plain");
    expect(await t.send("thr_plain")).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_plain")?.codeMode).toMatchObject({ codeMode: "off" });
    expect(await t.resolve("thr_plain")).toEqual([]);
  });

  it("refuses on a machine that is not turned on, naming it, and records nothing", async () => {
    const t = await setup();
    t.thread("thr_x");
    const decision = await t.send("thr_x", { ...t.codeModeSend, host: { id: OTHER_HOST, name: "Work Laptop" } });
    expect(decision).toMatchObject({ action: "reject" });
    expect(decision.action === "reject" && decision.message).toContain("Code Mode is off on Work Laptop");
    expect(t.metadata.has("thr_x")).toBe(false);
    expect(await t.resolve("thr_x", OTHER_HOST)).toEqual([]);
  });

  it("refuses where the machine is on but the wrapper can't be written, and records nothing", async () => {
    const t = await setup({ hostReady: false });
    await t.turnOnHost();
    t.thread("thr_x");
    const decision = await t.send("thr_x", { ...t.codeModeSend, host: { id: HOST, name: "MacMini" } });
    expect(decision.action === "reject" && decision.message).toContain("Code Mode's wrapper isn't ready on MacMini: Windows");
    expect(t.metadata.has("thr_x")).toBe(false);
  });

  it("records Send without Code Mode in a project that starts in Code Mode", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_out");
    expect(await t.send("thr_out", { experimental_submission: { pluginId: PLUGIN_ID, data: { codeMode: false } } })).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_out")?.codeMode).toMatchObject({ codeMode: "off", reason: "sent without Code Mode" });
    expect(await t.resolve("thr_out")).toEqual([]);
  });

  it("only counts this plugin's own submission data", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_other");
    await t.send("thr_other", { experimental_submission: { pluginId: "someone-else", data: { codeMode: true } } });
    expect(await t.resolve("thr_other")).toEqual([]);
  });
});

describe("the model guard", () => {
  it("refuses a send that would move a Code Mode thread to an older model, with the reason", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_cm");
    await t.send("thr_cm", t.codeModeSend);
    t.started("thr_cm");
    const decision = await t.send("thr_cm", { requestedExecution: { model: "claude-opus-5" } });
    expect(decision).toMatchObject({ action: "reject" });
    expect(decision.action === "reject" && decision.message).toContain("runs in Code Mode");
    expect(await t.send("thr_cm", { requestedExecution: { model: "claude-sonnet-5-5" } })).toEqual({ action: "proceed" });
  });

  it("refuses Send in Code Mode on a model without Code Mode", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_old");
    expect(await t.send("thr_old", { ...t.codeModeSend, requestedExecution: { model: "claude-opus-4-8" } })).toMatchObject({ action: "reject" });
    expect(t.metadata.has("thr_old")).toBe(false);
  });

  it("does not touch ordinary threads on old models", async () => {
    const t = await setup();
    t.thread("thr_plain");
    await t.send("thr_plain");
    t.started("thr_plain");
    expect(await t.send("thr_plain", { requestedExecution: { model: "claude-opus-4-8" } })).toEqual({ action: "proceed" });
  });
});

describe("project defaults and machines", () => {
  it("starts new threads in a project that is turned on, only on machines that are turned on", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_here");
    await t.send("thr_here");
    expect(await t.resolve("thr_here")).toEqual(WRAPPER_ENTRY);
    t.thread("thr_there");
    await t.send("thr_there", { host: { id: OTHER_HOST } });
    expect(await t.resolve("thr_there", OTHER_HOST)).toEqual([]);
  });

  it("switch projects by name: every same-named project, and one added later, follows the row", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_other_checkout", { projectId: "proj_other_checkout" });
    await t.send("thr_other_checkout");
    expect(await t.resolve("thr_other_checkout")).toEqual(WRAPPER_ENTRY);
    t.thread("thr_billing", { projectId: "proj_billing" });
    await t.send("thr_billing");
    expect(await t.resolve("thr_billing")).toEqual([]);
  });

  it("move switches saved by project id (a pre-release build) to the projects' names", async () => {
    const t = await setup({ storedConfig: { projects: { [PROJECT]: true, proj_gone: true }, hosts: { [HOST]: true } } });
    expect(await t.harness.behavior.callRpc("config.get", {})).toEqual({ projectNames: { [PROJECT_NAME]: true }, hosts: { [HOST]: true } });
    expect(await t.bb.storage.kv.get("config")).toEqual({ projectNames: { [PROJECT_NAME]: true }, hosts: { [HOST]: true } });
  });

  it("keeps a Code Mode thread in Code Mode after its machine is turned off", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_cm");
    await t.send("thr_cm", t.codeModeSend);
    await t.harness.behavior.callRpc("config.setHost", { hostId: HOST, on: false });
    expect(await t.resolve("thr_cm")).toEqual(WRAPPER_ENTRY);
  });

  it("leaves a default-on thread off where the wrapper can't be written, and says why", async () => {
    const t = await setup({ hostReady: false });
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_cm");
    expect(await t.send("thr_cm")).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_cm")?.codeMode).toMatchObject({ codeMode: "off", reason: expect.stringContaining("wrapper isn't ready") });
    expect(await t.resolve("thr_cm")).toEqual([]);
    expect(t.harness.inspection.logEntries.some((entry) => entry.message.includes("wrapper is not ready"))).toBe(true);
  });

  it("check the machines that are on after loading, never while loading (regression: both Send rows greyed after a reload)", async () => {
    const t = await setup({ storedConfig: { projectNames: {}, hosts: { [HOST]: true } } });
    expect(t.hostCalls).toEqual([]);
    expect(await t.harness.behavior.callRpc("hosts.status", {})).toEqual({});
    const service = t.harness.behavior.runService(MACHINE_CHECKS_SERVICE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.hostCalls).toEqual([HOST]);
    expect(await t.harness.behavior.callRpc("hosts.status", {})).toEqual({ [HOST]: { ok: true, message: "Wrapper ready" } });
    service.controller.abort();
    await service.done;
  });

  it("tell the app each checked machine's wrapper status", async () => {
    const t = await setup({ hostReady: false });
    await t.harness.behavior.callRpc("hosts.check", { hostId: HOST });
    expect(await t.harness.behavior.callRpc("hosts.status", {})).toEqual({ [HOST]: { ok: false, message: "Windows" } });
    expect(t.harness.inspection.experimental_rpcInvalidations).toContainEqual(["hosts"]);
  });
});

describe("threads agents and plugins start", () => {
  it("follow the project's default unless the setting says otherwise", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_child", { parentThreadId: "thr_parent" });
    await t.send("thr_child", { initiator: "agent", senderThreadId: "thr_parent" });
    expect(await t.resolve("thr_child")).toEqual(WRAPPER_ENTRY);
  });

  it("stay off with the setting at Never", async () => {
    const t = await setup({ settings: { [SPAWNED_SETTING]: "off" } });
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_crew", { originPluginId: "firstmate-crew" });
    await t.send("thr_crew", { initiator: "agent" });
    expect(await t.resolve("thr_crew")).toEqual([]);
  });

  it("follow the thread that started them with the setting at Same as", async () => {
    const t = await setup({ settings: { [SPAWNED_SETTING]: "parent" } });
    await t.turnOnHost();
    t.thread("thr_parent");
    await t.send("thr_parent", t.codeModeSend);
    t.thread("thr_child", { parentThreadId: "thr_parent" });
    await t.send("thr_child", { initiator: "agent", senderThreadId: "thr_parent" });
    expect(await t.resolve("thr_child")).toEqual(WRAPPER_ENTRY);
    t.thread("thr_plain_parent");
    await t.send("thr_plain_parent");
    t.thread("thr_plain_child", { parentThreadId: "thr_plain_parent" });
    await t.send("thr_plain_child", { initiator: "agent", senderThreadId: "thr_plain_parent" });
    expect(await t.resolve("thr_plain_child")).toEqual([]);
  });
});

describe("forks", () => {
  it("inherit the source thread's choice, whether bb starts them first or a message does", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_src");
    await t.send("thr_src", t.codeModeSend);
    t.started("thr_src");
    t.thread("thr_fork", { originKind: "fork", sourceThreadId: "thr_src", parentThreadId: "thr_src", status: "idle" });
    expect(await t.resolve("thr_fork")).toEqual(WRAPPER_ENTRY);
    t.thread("thr_fork2", { originKind: "fork", sourceThreadId: "thr_src", parentThreadId: "thr_src", status: "idle" });
    expect(await t.send("thr_fork2", { attempt: "start-turn" })).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_fork2")?.codeMode).toMatchObject({ codeMode: "on", reason: "forked from a Code Mode thread" });
  });

  it("made while the plugin was off and already run stay ordinary after it comes back, through the resolver and the hook", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_src");
    await t.send("thr_src", t.codeModeSend);
    t.started("thr_src");
    // Forked, and run with the ordinary tools, while the plugin was off: made before this load.
    t.thread("thr_old_fork", { originKind: "fork", sourceThreadId: "thr_src", parentThreadId: "thr_src", status: "idle", createdAt: 1_000 });
    expect(await t.resolve("thr_old_fork")).toEqual([]);
    expect(await t.send("thr_old_fork", { requestedExecution: { model: "claude-opus-5" } })).toEqual({ action: "proceed" });
    expect(t.metadata.has("thr_old_fork")).toBe(false);
    t.thread("thr_old_fork2", { originKind: "fork", sourceThreadId: "thr_src", parentThreadId: "thr_src", status: "idle", createdAt: 1_000 });
    expect(await t.send("thr_old_fork2")).toEqual({ action: "proceed" });
    expect(await t.resolve("thr_old_fork2")).toEqual([]);
    expect(t.metadata.has("thr_old_fork2")).toBe(false);
  });

  it("made while the plugin was off but never launched still take their source's choice", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_src");
    await t.send("thr_src", t.codeModeSend);
    t.thread("thr_pending_fork", { originKind: "fork", sourceThreadId: "thr_src", parentThreadId: "thr_src", status: "pending", createdAt: 1_000 });
    expect(await t.send("thr_pending_fork")).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_pending_fork")?.codeMode).toMatchObject({ codeMode: "on", reason: "forked from a Code Mode thread" });
    expect(await t.resolve("thr_pending_fork")).toEqual(WRAPPER_ENTRY);
  });

  it("of an ordinary thread stay ordinary, even in a project that is turned on", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_src");
    await t.send("thr_src");
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_fork", { originKind: "fork", sourceThreadId: "thr_src", status: "idle" });
    expect(await t.resolve("thr_fork")).toEqual([]);
  });
});

describe("the resolver's fallback", () => {
  it("gives nothing to threads that existed before the plugin, and writes nothing on them", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_old", { createdAt: 500, status: "idle" });
    expect(await t.send("thr_old")).toEqual({ action: "proceed" });
    expect(await t.resolve("thr_old")).toEqual([]);
    expect(t.metadata.has("thr_old")).toBe(false);
  });

  it("gives nothing to a thread that already ran a turn without the plugin", async () => {
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_ran", { status: "idle" });
    t.turns.add("thr_ran");
    expect(await t.resolve("thr_ran")).toEqual([]);
  });

  it("leaves a thread whose first message skipped the hook alone, in a project that starts in Code Mode, and writes nothing", async () => {
    // "Send now" on a queued first message, possibly on a model without Code Mode, or a steer during
    // the first turn of a thread that started while the plugin was off: the resolver can't tell which.
    const t = await setup();
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    t.thread("thr_now", { status: "starting" });
    expect(await t.resolve("thr_now")).toEqual([]);
    expect(t.metadata.has("thr_now")).toBe(false);
    expect(await t.resolve("thr_now")).toEqual([]);
  });

  it("records a new thread off when its machine's wrapper failed its latest check, though an earlier one passed", async () => {
    let ready = true;
    const t = await setup({ hostReady: () => ready });
    await t.turnOnHost();
    await t.harness.behavior.callRpc("config.setProjectName", { name: PROJECT_NAME, on: true });
    await t.harness.behavior.callRpc("hosts.check", { hostId: HOST });
    t.thread("thr_before");
    await t.send("thr_before");
    expect(t.metadata.get("thr_before")?.codeMode).toMatchObject({ codeMode: "on" });
    ready = false;
    await t.harness.behavior.callRpc("hosts.check", { hostId: HOST });
    t.thread("thr_after");
    expect(await t.send("thr_after")).toEqual({ action: "proceed" });
    expect(t.metadata.get("thr_after")?.codeMode).toMatchObject({ codeMode: "off", reason: expect.stringContaining("wrapper isn't ready") });
    expect(await t.send("thr_after", t.codeModeSend)).toEqual({ action: "proceed" });
    // The thread already in Code Mode keeps getting the wrapper it can only resume with.
    expect(await t.resolve("thr_before")).toEqual(WRAPPER_ENTRY);
  });

  it("never touches a provider process that serves no thread", async () => {
    const t = await setup();
    expect(await t.resolve(null)).toEqual([]);
  });

  it("gives nothing, rather than failing, when bb can't say what the thread is", async () => {
    const t = await setup();
    expect(await t.resolve("thr_unknown")).toEqual([]);
  });

  it("gives the same answer after a reload, from the record on the thread", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_cm");
    await t.send("thr_cm", t.codeModeSend);
    const reloaded = await t.harness.lifecycle.reload(plugin);
    expect(await reloaded.harness.behavior.resolveProviderEnv("claude-code", { threadId: "thr_cm", projectId: PROJECT, hostId: HOST })).toEqual(WRAPPER_ENTRY);
  });
});

describe("the app's reads", () => {
  it("say which threads are in Code Mode", async () => {
    const t = await setup();
    await t.turnOnHost();
    t.thread("thr_cm");
    await t.send("thr_cm", t.codeModeSend);
    t.thread("thr_plain");
    await t.send("thr_plain");
    expect(await t.harness.behavior.callRpc("threads.state", { keys: ["thr_cm", "thr_plain", "thr_none"] })).toEqual({
      thr_cm: { state: "on" },
      thr_plain: { state: "off" },
      thr_none: { state: "none" },
    });
  });

  it("turn many project names and machines on and off in one write", async () => {
    const t = await setup();
    expect(await t.harness.behavior.callRpc("config.setProjectNames", { names: ["Acme Web", "Billing API"], on: true })).toEqual({ projectNames: { "Acme Web": true, "Billing API": true }, hosts: {} });
    expect(await t.harness.behavior.callRpc("config.setProjectNames", { names: ["Acme Web"], on: false })).toEqual({ projectNames: { "Billing API": true }, hosts: {} });
    expect(await t.harness.behavior.callRpc("config.setHosts", { hostIds: [HOST, OTHER_HOST], on: true })).toMatchObject({ hosts: { [HOST]: true, [OTHER_HOST]: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.hostCalls).toEqual(expect.arrayContaining([HOST, OTHER_HOST]));
    expect(await t.harness.behavior.callRpc("config.setHosts", { hostIds: [HOST, OTHER_HOST], on: false })).toMatchObject({ hosts: {} });
  });

  it("write the wrapper on a machine when it is turned on", async () => {
    const t = await setup();
    await t.turnOnHost();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.hostCalls).toContain(HOST);
    expect(await t.harness.behavior.callRpc("hosts.check", { hostId: HOST })).toEqual({ ok: true, message: `Ready: ${LAUNCHER}` });
  });
});
