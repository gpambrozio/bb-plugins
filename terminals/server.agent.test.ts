/**
 * The agent a tab asks for help, through the whole server on the SDK's fake
 * host: starting its thread, which thread gets the tab's tools, what those
 * tools read and type, sending it a failure, and letting go of it.
 */
import { createFakePluginHost, makePluginAgentConfigurationContext, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import plugin from "./server";
import type { ListedTab, TabView } from "./shared/tabs";

const osc = (body: string) => `\u001b]${body}\u0007`;
const prompt = `${osc("133;A")}~ % ${osc("133;B")}`;

async function start(
  options: {
    settings?: Record<string, boolean>;
    existing?: { id: string; visibility: string }[];
    /** Holds each spawn until the test releases it, by its order. */
    holdSpawns?: boolean;
    /** Runs before each read of the terminal's output answers. */
    beforeOutput?: () => Promise<void>;
  } = {},
) {
  const held: { release: () => void; fail: (error: Error) => void }[] = [];
  const output: { seq: number; dataBase64: string }[] = [];
  const print = (text: string) => output.push({ seq: output.length, dataBase64: Buffer.from(text).toString("base64") });
  const typed: string[] = [];
  const threads = new Map<string, { archivedAt: number | null; deletedAt: number | null; visibility: string; metadata?: Record<string, unknown> }>();
  for (const thread of options.existing ?? []) threads.set(thread.id, { archivedAt: null, deletedAt: null, visibility: thread.visibility });
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "terminals",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    agentSkillIds: ["terminals"],
    sdk: {
      system: { config: async () => ({ primaryHostId: "mini" }) as never },
      hosts: { list: async () => [makeHostResponse({ id: "mini", name: "Mac mini" })] },
      terminals: {
        create: async ({ id }) => ({ id, status: "running", exitCode: null, cols: 80, rows: 24 }) as never,
        get: async ({ terminalId }) => ({ id: terminalId, status: "running", exitCode: null, cols: 80, rows: 24 }) as never,
        close: async ({ terminalId }) => ({ id: terminalId, status: "exited", exitCode: 0 }) as never,
        output: async ({ sinceSeq, tailBytes }) => {
          await options.beforeOutput?.();
          return {
            chunks: output.filter((chunk) => chunk.seq >= (tailBytes !== undefined ? 0 : (sinceSeq ?? 0))),
            nextSeq: output.length,
            status: "running",
            exitCode: null,
            closeReason: null,
            truncated: false,
          } as never;
        },
        input: async ({ dataBase64 }) => {
          const data = Buffer.from(dataBase64, "base64").toString("utf8");
          typed.push(data);
          // An integrated shell: echoes what is typed; on Enter, runs it, prints its exit status, prompts again.
          if (data === "\r") print(`\r\n${osc("133;C")}On branch main\r\n${osc("133;D;0")}${prompt}`);
          else print(data);
          return {} as never;
        },
      },
      threads: {
        spawn: async (args) => {
          const id = `thr_${++spawned}`;
          if (options.holdSpawns) {
            await new Promise<void>((release, fail) => held.push({ release, fail }));
          }
          threads.set(id, {
            archivedAt: null,
            deletedAt: null,
            visibility: (args as { visibility?: string }).visibility ?? "visible",
            metadata: (args as { pluginMetadata?: Record<string, unknown> }).pluginMetadata ?? {},
          });
          return { id } as never;
        },
        list: async ({ offset = 0, limit = 100 } = {}) =>
          [...threads].filter(([, thread]) => thread.archivedAt === null).map(([id, thread]) => ({ id, visibility: thread.visibility })).slice(offset, offset + limit) as never,
        update: async ({ threadId, visibility }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw new Error("not found");
          if (visibility !== undefined) thread.visibility = visibility;
          return { id: threadId } as never;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          return { id: threadId, ...thread } as never;
        },
        send: async () => ({}) as never,
        stop: async () => ({}) as never,
        getPluginMetadata: async ({ threadId }) => (threads.get(threadId)?.metadata ?? {}) as never,
        experimental_listPluginMetadata: async ({ threadIds }) =>
          ({ threads: threadIds.map((threadId) => ({ threadId, metadata: threads.get(threadId)?.metadata ?? {} })) }) as never,
        archive: async ({ threadId }) => {
          threads.get(threadId)!.archivedAt = 1;
          return {} as never;
        },
      },
    },
  });
  await plugin(bb);
  const tab = (await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 })) as TabView;
  print(prompt);
  /** Lets the `index`th held spawn (from 0) answer, or fail. */
  const answerSpawn = async (index: number, error?: Error) => {
    await expect.poll(() => held.length).toBeGreaterThan(index);
    if (error === undefined) held[index]!.release();
    else held[index]!.fail(error);
  };
  return { bb, harness, tab, typed, threads, print, answerSpawn };
}

const request = {
  projectId: "proj_app",
  providerId: "claude-code",
  model: "opus",
  reasoningLevel: "high",
  permissionMode: "auto",
  executionInputSources: {},
  environment: { type: "host", hostId: "mini", workspace: { type: "unmanaged", path: null } },
  input: [{ type: "text", text: "A command failed in my terminal", mentions: [] }],
};

async function listed(harness: { callRpc(method: string, input: unknown): Promise<unknown> }): Promise<ListedTab[]> {
  return ((await harness.callRpc("list", {})) as { tabs: ListedTab[] }).tabs;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: { text: string }[] }).content.map((part) => part.text).join("");
}

describe("a tab's agent", () => {
  it("starts the thread with the user's choices, marked as the tab's, and lists it with the tab", async () => {
    const { harness, tab } = await start();
    const started = (await harness.callRpc("startAgent", {
      terminalId: tab.terminalId,
      request: { ...request, parentThreadId: "thr_sneaky", visibility: "visible" },
    })) as { threadId: string };
    expect(started).toEqual({ threadId: "thr_1" });
    const [spawn] = harness.sdk.callsTo("threads.spawn") as [Record<string, unknown>][];
    expect(spawn?.[0]).toMatchObject({ ...request, pluginMetadata: { terminalId: tab.terminalId }, visibility: "hidden" });
    // Filing is the plugin's: a request cannot choose where the thread shows or make it another's child.
    expect(spawn?.[0]).not.toHaveProperty("parentThreadId");
    expect(await listed(harness)).toMatchObject([{ terminalId: tab.terminalId, agentThreadId: "thr_1" }]);
  });

  it("shows the tab's chat in the sidebar for good when the user opens it as a normal thread", async () => {
    const { harness, tab, threads } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    expect(threads.get("thr_1")?.visibility).toBe("hidden");
    expect(await harness.callRpc("showAgentChat", { terminalId: tab.terminalId })).toEqual({ threadId: "thr_1" });
    expect(harness.sdk.callsTo("threads.update")).toEqual([[{ threadId: "thr_1", visibility: "visible" }]]);
    expect(threads.get("thr_1")?.visibility).toBe("visible");
    await harness.callRpc("forgetAgent", { terminalId: tab.terminalId });
    await expect(harness.callRpc("showAgentChat", { terminalId: tab.terminalId })).rejects.toThrow(/no agent chat/);
  });

  it("starts chats in the sidebar when the owner always shows them, and shows the hidden ones when they turn it on", async () => {
    const shown = await start({ settings: { alwaysShowAgentChats: true } });
    await shown.harness.callRpc("startAgent", { terminalId: shown.tab.terminalId, request });
    expect(shown.threads.get("thr_1")?.visibility).toBe("visible");

    const { harness, tab, threads } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    expect(threads.get("thr_1")?.visibility).toBe("hidden");
    await harness.setSettings({ alwaysShowAgentChats: true });
    await expect.poll(() => threads.get("thr_1")?.visibility).toBe("visible");
    // Turning it off again leaves the chats as they are; new ones start hidden.
    await harness.setSettings({ alwaysShowAgentChats: false });
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    expect(threads.get("thr_1")?.visibility).toBe("visible");
    expect(threads.get("thr_2")?.visibility).toBe("hidden");
  });

  it("hides the agent chats started before chats were hidden, once per install", async () => {
    const { bb, harness, threads } = await start({ existing: [{ id: "thr_before", visibility: "visible" }] });
    const service = harness.runService("prune-ended-tabs");
    await expect.poll(() => threads.get("thr_before")?.visibility).toBe("hidden");
    // Recorded, so a chat the owner opens as a normal thread later is not hidden again (server/chat-visibility.test.ts).
    await expect.poll(() => bb.storage.kv.get("agentChatsHidden")).toBe(true);
    service.controller.abort();
    await service.done;
  });

  it("gives the tab's tools only to its own thread, and the skill to every thread", async () => {
    const { harness, tab } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    const own = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, pluginMetadata: { terminalId: tab.terminalId } }),
    );
    expect(own.tools.map((tool) => tool.name)).toEqual(["terminal_read", "terminal_run"]);
    expect(own.skills).toEqual(["terminals"]);
    // The thread is told where the user is and what its tools reach, since its first message does not quote the terminal.
    expect(own.instructions).toContain("The user is working in a terminal and wants your help with it.");
    expect(own.instructions).toContain('terminal tab "Mac mini" on the machine "Mac mini"');
    expect(own.instructions).toMatch(/`terminal_read` reads what it shows now.*`terminal_run` types one command into it/s);
    // What the user asks it to run goes to that terminal, at once.
    expect(own.instructions).toContain(
      "When the user asks you to run something, run it in that terminal with `terminal_run`, not in your own shell or with any other tool, and do not ask them to confirm first: their asking is the confirmation.",
    );

    // A fork, or any thread that writes the tab's id into its own metadata, gets nothing.
    const other = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_other" }, pluginMetadata: { terminalId: tab.terminalId } }),
    );
    expect(other.tools).toEqual([]);
    expect(other.skills).toEqual(["terminals"]);
    const plain = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(plain.tools).toEqual([]);
  });

  it("reads and runs commands in that tab for its thread, and tells the page what it typed", async () => {
    const { harness, tab, typed } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    const read = await harness.callAgentTool("terminal_read", {}, { threadId: "thr_1" });
    expect(text(read)).toContain("The shell is at its prompt.");

    const ran = await harness.callAgentTool("terminal_run", { command: "git status" }, { threadId: "thr_1" });
    expect(text(ran)).toContain("Ran `git status`");
    expect(text(ran)).toContain("succeeded (exit code 0)");
    expect(text(ran)).toContain("On branch main");
    expect(typed).toEqual(["git status", "\r"]);
    // Kept with the tab first, then the windows are told.
    await expect
      .poll(() => harness.realtimeSignals)
      .toContainEqual(expect.objectContaining({ channel: "agent-typed", payload: { terminalId: tab.terminalId, command: "git status" } }));
    expect(await harness.callRpc("agentCommands", { terminalId: tab.terminalId })).toEqual({
      threadId: "thr_1",
      commands: [{ command: "git status", at: expect.any(Number) }],
    });
  });

  it("gives the tab's thread the owner's instructions after the fixed line, and the built-in ones again once restored", async () => {
    const { harness, tab } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    const resolve = async () =>
      (
        await harness.resolveAgentConfiguration(
          makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, pluginMetadata: { terminalId: tab.terminalId } }),
        )
      ).instructions;
    const builtIn = await resolve();
    expect(await harness.callRpc("agentInstructions", {})).toEqual({ text: null });

    expect(await harness.callRpc("setAgentInstructions", { text: "  Answer in French. You work in {{tab}}.\n" })).toEqual({
      text: "Answer in French. You work in {{tab}}.",
    });
    expect(await harness.callRpc("agentInstructions", {})).toEqual({ text: "Answer in French. You work in {{tab}}." });
    expect(await resolve()).toBe(
      'This chat is attached to the user\'s terminal tab "Mac mini" on the machine "Mac mini": `terminal_read` and `terminal_run` act on that tab.\n\nAnswer in French. You work in "Mac mini".',
    );

    expect(await harness.callRpc("setAgentInstructions", { text: null })).toEqual({ text: null });
    expect(await resolve()).toBe(builtIn);
  });

  it("reads the instructions again before starting a thread, for a copy of the plugin that saved them since", async () => {
    const { bb, harness, tab } = await start();
    await bb.storage.kv.set("agentInstructions", "Saved by the other copy.");
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    const resolved = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, pluginMetadata: { terminalId: tab.terminalId } }),
    );
    expect(resolved.instructions).toContain("Saved by the other copy.");
  });

  it("keeps the chat's commands across a reload, and drops them when the chat ends for the tab", async () => {
    const { harness, tab } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await harness.callAgentTool("terminal_run", { command: "ls" }, { threadId: "thr_1" });
    await harness.callAgentTool("terminal_run", { command: "pwd" }, { threadId: "thr_1" });
    const listed = async (host: { callRpc(method: string, input: unknown): Promise<unknown> }) =>
      ((await host.callRpc("agentCommands", { terminalId: tab.terminalId })) as { commands: { command: string }[] }).commands.map(
        (entry) => entry.command,
      );
    await expect.poll(() => listed(harness)).toEqual(["ls", "pwd"]);

    const reloaded = await harness.reload(plugin);
    expect(await listed(reloaded.harness)).toEqual(["ls", "pwd"]);

    // A new chat from the panel lets go of this one: its commands go.
    await reloaded.harness.callRpc("forgetAgent", { terminalId: tab.terminalId });
    expect(await listed(reloaded.harness)).toEqual([]);
  });

  it("starts a new chat's list empty, and forgets the list when the tab closes", async () => {
    const { bb, harness, tab } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await harness.callAgentTool("terminal_run", { command: "ls" }, { threadId: "thr_1" });
    await expect.poll(async () => bb.storage.kv.list("agent-commands:")).toHaveLength(1);
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    expect(await harness.callRpc("agentCommands", { terminalId: tab.terminalId })).toEqual({ threadId: "thr_2", commands: [] });
    await harness.callAgentTool("terminal_run", { command: "pwd" }, { threadId: "thr_2" });
    await expect.poll(async () => bb.storage.kv.get("agent-commands:" + tab.terminalId)).toMatchObject({ threadId: "thr_2" });
    await harness.callRpc("close", { terminalId: tab.terminalId });
    expect(await bb.storage.kv.list("agent-commands:")).toEqual([]);
  });

  it("refuses the tools to any other thread, and after the user lets go of the chat", async () => {
    const { harness, tab, typed } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    const stranger = await harness.callAgentTool("terminal_run", { command: "rm -rf ~" }, { threadId: "thr_other" });
    expect(stranger).toMatchObject({ isError: true });
    expect(text(stranger)).toContain("not connected to a terminal");

    await harness.callRpc("forgetAgent", { terminalId: tab.terminalId });
    const after = await harness.callAgentTool("terminal_read", {}, { threadId: "thr_1" });
    expect(after).toMatchObject({ isError: true });
    expect(await listed(harness)).toMatchObject([{ agentThreadId: null }]);
    expect(typed).toEqual([]);
  });

  it("sends a failure to the tab's thread, and says so once that thread was archived", async () => {
    const { harness, tab, threads } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await harness.callRpc("askAgent", { terminalId: tab.terminalId, text: "It failed again" });
    expect(harness.sdk.callsTo("threads.send")).toEqual([[{ threadId: "thr_1", mode: "auto", input: [{ type: "text", text: "It failed again" }] }]]);

    threads.get("thr_1")!.archivedAt = 5;
    await expect(harness.callRpc("askAgent", { terminalId: tab.terminalId, text: "Again" })).rejects.toThrow(/no agent chat any more/);
    expect(await listed(harness)).toMatchObject([{ agentThreadId: null }]);
  });

  it("binds only the newest chat when two windows start one for the same tab and the spawns answer out of order", async () => {
    const { harness, tab, threads, answerSpawn } = await start({ holdSpawns: true });
    const older = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(1);
    const newer = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(2);
    await answerSpawn(1);
    expect(await newer).toEqual({ threadId: "thr_2" });
    await answerSpawn(0);
    await expect(older).rejects.toThrow(/another one was started for this terminal/);
    expect(await listed(harness)).toMatchObject([{ agentThreadId: "thr_2" }]);
    // The superseded chat is stopped and archived, and has no tools.
    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_1" }]]);
    expect(threads.get("thr_1")?.archivedAt).not.toBeNull();
    const stale = await harness.callAgentTool("terminal_read", {}, { threadId: "thr_1" });
    expect(stale).toMatchObject({ isError: true });
  });

  it("does not bring back a chat the user let go of, or whose tab closed, while bb was creating it", async () => {
    const forgotten = await start({ holdSpawns: true });
    const starting = forgotten.harness.callRpc("startAgent", { terminalId: forgotten.tab.terminalId, request });
    await expect.poll(() => forgotten.harness.sdk.callsTo("threads.spawn").length).toBe(1);
    await forgotten.harness.callRpc("forgetAgent", { terminalId: forgotten.tab.terminalId });
    await forgotten.answerSpawn(0);
    await expect(starting).rejects.toThrow(/its chat was let go of/);
    expect(await listed(forgotten.harness)).toMatchObject([{ agentThreadId: null }]);
    expect(forgotten.harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_1" }]]);

    const closed = await start({ holdSpawns: true });
    const opening = closed.harness.callRpc("startAgent", { terminalId: closed.tab.terminalId, request });
    await expect.poll(() => closed.harness.sdk.callsTo("threads.spawn").length).toBe(1);
    await closed.harness.callRpc("close", { terminalId: closed.tab.terminalId });
    await closed.answerSpawn(0);
    await expect(opening).rejects.toThrow(/tab closed/);
    expect(closed.harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_1" }]]);
    expect(await closed.bb.storage.kv.get("agents")).toEqual([]);
  });

  it("keeps the newer copy's chat when a spawn from before a reload answers after it", async () => {
    const { harness, tab, threads, answerSpawn } = await start({ holdSpawns: true });
    const before = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(1);
    const reloaded = await harness.reload(plugin);
    const after = reloaded.harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await answerSpawn(1);
    expect(await after).toEqual({ threadId: "thr_2" });

    // The old copy's spawn answers last: it binds nothing, the stored links keep the newer chat, and the
    // newer copy archives the old copy's thread when bb reports it (the old copy's calls are refused).
    await answerSpawn(0);
    await expect(before).rejects.toThrow(/reloaded while this chat was starting/);
    await reloaded.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_1", originPluginId: "terminals" }) });
    await expect.poll(() => threads.get("thr_1")?.archivedAt).not.toBeNull();
    // Its own chat is left alone.
    await reloaded.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_2", originPluginId: "terminals" }) });
    expect(threads.get("thr_2")?.archivedAt).toBeNull();
    expect(await reloaded.bb.storage.kv.get("agents")).toMatchObject([{ terminalId: tab.terminalId, threadId: "thr_2" }]);
    expect(await listed(reloaded.harness)).toMatchObject([{ agentThreadId: "thr_2" }]);
    const resolved = await reloaded.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_2" }, pluginMetadata: { terminalId: tab.terminalId } }),
    );
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["terminal_read", "terminal_run"]);
  });

  it("binds nothing when the plugin is reloaded while a new chat's tab is being checked", async () => {
    const { harness, tab, threads, answerSpawn, bb } = await start({ holdSpawns: true });
    const starting = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(1);
    // Hold the old copy's read of the tabs that follows the spawn.
    let releaseRead = () => {};
    let reading = false;
    const get = bb.storage.kv.get.bind(bb.storage.kv);
    bb.storage.kv.get = (async (key: string) => {
      if (key === "tabs") {
        reading = true;
        await new Promise<void>((resolve) => (releaseRead = resolve));
      }
      return get(key);
    }) as typeof bb.storage.kv.get;
    await answerSpawn(0);
    await expect.poll(() => reading).toBe(true);
    const reloaded = await harness.reload(plugin);
    releaseRead();
    await expect(starting).rejects.toThrow(/reloaded while this chat was starting/);
    expect(await listed(reloaded.harness)).toMatchObject([{ agentThreadId: null }]);
    // The thread existed when the newer copy loaded: the sweep as it starts archives it.
    const service = reloaded.harness.runService("prune-ended-tabs");
    await expect.poll(() => threads.get("thr_1")?.archivedAt).not.toBeNull();
    service.controller.abort();
    await service.done;
    expect(await reloaded.bb.storage.kv.get("agents")).toEqual([]);
  });

  it("archives the old copy's chat when its bind, already being saved, lands after the reload revoked it", async () => {
    const { harness, tab, threads, answerSpawn, bb } = await start({ holdSpawns: true });
    const starting = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(1);
    // Hold the old copy's save of the bind. It was sent before the reload, so it lands in the shared
    // storage after it (the fake host refuses the old handle by then, so the test writes it there).
    let held: unknown = null;
    let saving = false;
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    bb.storage.kv.set = (async (key: string, value: unknown) => {
      if (key === "agents" && (value as { threadId: string | null }[]).some((link) => link.threadId === "thr_1")) {
        saving = true;
        held = value;
        return;
      }
      return set(key, value);
    }) as typeof bb.storage.kv.set;
    await answerSpawn(0);
    await expect.poll(() => saving).toBe(true);

    // The newer copy loads, revoking the pending spawn; then the old save lands, putting the link back.
    const reloaded = await harness.reload(plugin);
    await reloaded.bb.storage.kv.set("agents", held);
    await starting.catch(() => undefined);
    expect(await reloaded.bb.storage.kv.get("agents")).toMatchObject([{ threadId: "thr_1" }]);

    // The newer copy ignores it: no chat for the tab, no tools for that thread, and its sweep archives it.
    expect(await listed(reloaded.harness)).toMatchObject([{ agentThreadId: null }]);
    const stale = await reloaded.harness.callAgentTool("terminal_read", {}, { threadId: "thr_1" });
    expect(stale).toMatchObject({ isError: true });
    const service = reloaded.harness.runService("prune-ended-tabs");
    await expect.poll(() => threads.get("thr_1")?.archivedAt).not.toBeNull();
    service.controller.abort();
    await service.done;
    expect(await reloaded.bb.storage.kv.get("agents")).toEqual([]);
  });

  it("never gives a forgotten chat its tools back when a late save left its link and a day passed before the next load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { harness, tab, bb } = await start();
      await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
      const snapshot = await bb.storage.kv.get("agents");
      await harness.callRpc("forgetAgent", { terminalId: tab.terminalId });
      // A save of an earlier copy of the plugin, under way before the chat was let go of, lands after it.
      await bb.storage.kv.set("agents", snapshot);
      expect(await bb.storage.kv.get("agents")).toMatchObject([{ threadId: "thr_1" }]);

      // Longer than a revocation is kept, then two reloads, each through its load-time prune.
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
      let copy = { harness, bb };
      for (let reload = 0; reload < 2; reload += 1) {
        copy = await copy.harness.reload(plugin);
        const service = copy.harness.runService("prune-ended-tabs");
        await expect.poll(async () => copy.bb.storage.kv.get("agents")).toEqual([]);
        service.controller.abort();
        await service.done;
        const config = await copy.harness.resolveAgentConfiguration(
          makePluginAgentConfigurationContext({ thread: { id: "thr_1" }, pluginMetadata: { terminalId: tab.terminalId } }),
        );
        expect(config.tools).toEqual([]);
        for (const tool of ["terminal_read", "terminal_run"]) {
          const result = await copy.harness.callAgentTool(tool, tool === "terminal_run" ? { command: "pwd" } : {}, { threadId: "thr_1" });
          expect(result).toMatchObject({ isError: true });
        }
        expect(await listed(copy.harness)).toMatchObject([{ agentThreadId: null }]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer chat's link when an older spawn fails after it", async () => {
    const { harness, tab, answerSpawn } = await start({ holdSpawns: true });
    const older = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await expect.poll(() => harness.sdk.callsTo("threads.spawn").length).toBe(1);
    const newer = harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await answerSpawn(1);
    await newer;
    await answerSpawn(0, new Error("provider unavailable"));
    await expect(older).rejects.toThrow(/provider unavailable/);
    expect(await listed(harness)).toMatchObject([{ agentThreadId: "thr_2" }]);
  });

  it("types nothing when the user lets go of the chat while its command waits on the terminal's output", async () => {
    let gate: (() => void) | null = null;
    let holding = false;
    const setup = await start({
      beforeOutput: async () => {
        if (holding) await new Promise<void>((release) => (gate = release));
      },
    });
    await setup.harness.callRpc("startAgent", { terminalId: setup.tab.terminalId, request });
    holding = true;
    const run = setup.harness.callAgentTool("terminal_run", { command: "pwd" }, { threadId: "thr_1" });
    await expect.poll(() => gate !== null).toBe(true);
    holding = false;
    await setup.harness.callRpc("forgetAgent", { terminalId: setup.tab.terminalId });
    gate!();
    const result = await run;
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("not connected to a terminal");
    expect(setup.typed).toEqual([]);
  });

  it("lets go of the thread when its tab closes", async () => {
    const { harness, tab } = await start();
    await harness.callRpc("startAgent", { terminalId: tab.terminalId, request });
    await harness.callRpc("close", { terminalId: tab.terminalId });
    const after = await harness.callAgentTool("terminal_read", {}, { threadId: "thr_1" });
    expect(after).toMatchObject({ isError: true });
  });

  it("forgets the link again when bb could not start the thread", async () => {
    const { harness, tab } = await start();
    harness.sdk.stub("threads.spawn", async () => {
      throw new Error("no such project");
    });
    await expect(harness.callRpc("startAgent", { terminalId: tab.terminalId, request })).rejects.toThrow(/no such project/);
    const resolved = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_x" }, pluginMetadata: { terminalId: tab.terminalId } }),
    );
    expect(resolved.tools).toEqual([]);
  });
});
