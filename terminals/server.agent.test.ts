/**
 * The agent a tab asks for help, through the whole server on the SDK's fake
 * host: starting its thread, which thread gets the tab's tools, what those
 * tools read and type, sending it a failure, and letting go of it.
 */
import { createFakePluginHost, makePluginAgentConfigurationContext, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import type { ListedTab, TabView } from "./shared/tabs";

const osc = (body: string) => `\u001b]${body}\u0007`;
const prompt = `${osc("133;A")}~ % ${osc("133;B")}`;

async function start(options: { settings?: Record<string, boolean>; existing?: { id: string; visibility: string }[] } = {}) {
  const output: { seq: number; dataBase64: string }[] = [];
  const print = (text: string) => output.push({ seq: output.length, dataBase64: Buffer.from(text).toString("base64") });
  const typed: string[] = [];
  const threads = new Map<string, { archivedAt: number | null; deletedAt: number | null; visibility: string }>();
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
        output: async ({ sinceSeq, tailBytes }) =>
          ({
            chunks: output.filter((chunk) => chunk.seq >= (tailBytes !== undefined ? 0 : (sinceSeq ?? 0))),
            nextSeq: output.length,
            status: "running",
            exitCode: null,
            closeReason: null,
            truncated: false,
          }) as never,
        input: async ({ dataBase64 }) => {
          const line = Buffer.from(dataBase64, "base64").toString("utf8");
          typed.push(line);
          // An integrated shell: echo, run, exit status, prompt.
          print(`${line.trim()}\r\n${osc("133;C")}On branch main\r\n${osc("133;D;0")}${prompt}`);
          return {} as never;
        },
      },
      threads: {
        spawn: async (args) => {
          const id = `thr_${++spawned}`;
          threads.set(id, { archivedAt: null, deletedAt: null, visibility: (args as { visibility?: string }).visibility ?? "visible" });
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
      },
    },
  });
  await plugin(bb);
  const tab = (await harness.callRpc("open", { hostId: "mini", cols: 80, rows: 24 })) as TabView;
  print(prompt);
  return { bb, harness, tab, typed, threads, print };
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
    expect(typed).toEqual(["git status\r"]);
    expect(harness.realtimeSignals).toContainEqual(
      expect.objectContaining({ channel: "agent-typed", payload: { terminalId: tab.terminalId, command: "git status" } }),
    );
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
