/**
 * The agent a tab asks for help: starting its thread, sending it a failed
 * command, and the two tools only that thread gets — reading the tab, and
 * running a command in it (server/terminal-agent.ts).
 *
 * The thread's plugin metadata names the tab, which is how `configure`
 * recognises it while bb is still creating it; but metadata is writable by
 * any client, so it only hints. The link store decides (server/agent-links.ts),
 * and each tool call is checked again by the calling thread's id, which bb
 * supplies.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { READ_TOOL, RUN_TOOL, agentInstructions } from "../shared/agent";
import { tabLabels, type Tab } from "../shared/tabs";
import { PENDING_MS, type AgentLinks } from "./agent-links";
import {
  MAX_READ_LINES,
  MAX_RUN_TIMEOUT_MS,
  TerminalToolError,
  readTerminal,
  runCommand,
  type AgentTerminalPorts,
  type TabFacts,
} from "./terminal-agent";

/** The metadata key naming the tab a helper thread was started for. */
export const TERMINAL_METADATA_KEY = "terminalId";

/** The skill every thread gets, as the manifest names it (`skills/terminals/SKILL.md`). */
const SKILL = "terminals";

/** How long a tool call waits for `threads.spawn` to answer, when bb starts the thread's first turn before it does. */
const BIND_WAIT_MS = 15_000;

/**
 * The fields of the new-thread composer's request that are the user's
 * choices. The rest of a spawn (metadata, visibility, parentage) is the
 * plugin's, so a request cannot set it.
 */
const REQUEST_FIELDS = [
  "projectId",
  "providerId",
  "model",
  "reasoningLevel",
  "permissionMode",
  "serviceTier",
  "sessionOptions",
  "executionInputSources",
  "environment",
  "input",
] as const;

/** The spawn arguments for a composer's request, or a description of what is missing. */
export function spawnArgs(request: Record<string, unknown>, terminalId: string): Record<string, unknown> {
  if (typeof request.projectId !== "string" || request.projectId === "") throw new Error("The request names no project.");
  if (!Array.isArray(request.input) || request.input.length === 0) throw new Error("The request has no message.");
  if (typeof request.environment !== "object" || request.environment === null) throw new Error("The request names no environment.");
  const args: Record<string, unknown> = {};
  for (const field of REQUEST_FIELDS) if (request[field] !== undefined) args[field] = request[field];
  args.pluginMetadata = { [TERMINAL_METADATA_KEY]: terminalId };
  return args;
}

export interface AgentDeps {
  links: AgentLinks;
  /** The stored tabs. */
  tabs(): Promise<Tab[]>;
  /** The tabs as last read, for `configure`, which cannot wait. */
  cachedTabs(): readonly Tab[];
  ports: AgentTerminalPorts;
  sleep(ms: number): Promise<void>;
  /** The owner's instructions text as last read (null: the built-in one), for `configure`, which cannot wait. */
  cachedInstructions(): string | null;
  /** Reads the owner's instructions text again, so a thread about to start gets the latest. */
  loadInstructions(): Promise<unknown>;
  /** Whether a new chat shows in bb's sidebar: hidden unless the owner's setting says always show. */
  newChatVisibility(): Promise<"visible" | "hidden">;
}

function tabFacts(tabs: readonly Tab[], terminalId: string): TabFacts | null {
  const tab = tabs.find((entry) => entry.terminalId === terminalId);
  if (tab === undefined) return null;
  return { terminalId, label: tabLabels(tabs).get(terminalId) ?? tab.hostName, hostName: tab.hostName };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

export function registerAgent(bb: BbPluginApi, deps: AgentDeps) {
  const { links } = deps;

  /** The tab the calling thread helps with, waiting a little for a spawn that has not answered yet. */
  async function tabForThread(threadId: string, signal: AbortSignal): Promise<TabFacts> {
    const deadline = Date.now() + BIND_WAIT_MS;
    let terminalId = links.terminalFor(threadId);
    while (terminalId === null && Date.now() < deadline && !signal.aborted) {
      const pending = links.all().some((link) => link.threadId === null);
      if (!pending) break;
      await deps.sleep(200);
      terminalId = links.terminalFor(threadId);
    }
    if (terminalId === null) {
      throw new TerminalToolError(
        "This chat is not connected to a terminal any more: the user started another chat for it, let go of it, or closed its tab.",
      );
    }
    const facts = tabFacts(await deps.tabs(), terminalId);
    if (facts === null) throw new TerminalToolError("The terminal tab this chat was started from has been closed.");
    return facts;
  }

  async function asTool(work: () => Promise<string>) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof TerminalToolError)) bb.log.warn(`a terminal tool failed: ${errorText(error)}`);
      return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
    }
  }

  bb.agents.registerTool({
    name: READ_TOOL,
    description:
      "Read what the user's terminal tab (the one this chat was started from) shows now, as text: its last lines, the shell's directory, whether a command is running, and how the last command ended.",
    presentation: { label: { pending: "Reading the terminal", completed: "Read the terminal" }, icon: { glyph: "Terminal" } },
    parameters: z.object({
      lines: z.number().int().min(1).max(MAX_READ_LINES).optional().describe(`How many of the last lines to read (default 120, at most ${MAX_READ_LINES}).`),
    }),
    execute: ({ lines }, ctx) =>
      asTool(async () => readTerminal(deps.ports, await tabForThread(ctx.threadId, ctx.signal), lines === undefined ? {} : { lines })),
  });

  bb.agents.registerTool({
    name: RUN_TOOL,
    description:
      "Type one command into the user's terminal tab (the one this chat was started from), run it in their shell, and wait for it: returns what it printed and its exit code. The user sees it run. Refuses while a command is running, a full-screen program is open, or the user has typed something at the prompt.",
    presentation: { label: { pending: "Running a command in the terminal", completed: "Ran a command in the terminal" }, icon: { glyph: "Terminal" } },
    parameters: z.object({
      command: z.string().min(1).describe("One line of shell input, as the user would type it; join several commands with && or ;."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_RUN_TIMEOUT_MS / 1000)
        .optional()
        .describe("How long to wait for it to finish (default 30). A command still running then is left running."),
    }),
    execute: ({ command, timeoutSeconds }, ctx) =>
      asTool(async () =>
        runCommand(
          deps.ports,
          await tabForThread(ctx.threadId, ctx.signal),
          { command, ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }) },
          ctx.signal,
        ),
      ),
  });

  bb.agents.configure((context) => {
    const none = { tools: [], skills: [SKILL] };
    const terminalId = context.pluginMetadata[TERMINAL_METADATA_KEY];
    if (typeof terminalId !== "string" || !links.mayUse(terminalId, context.thread.id)) return none;
    const facts = tabFacts(deps.cachedTabs(), terminalId);
    if (facts === null) return none;
    return {
      tools: [READ_TOOL, RUN_TOOL],
      skills: [SKILL],
      instructions: agentInstructions({ tabLabel: facts.label, hostName: facts.hostName }, deps.cachedInstructions()),
    };
  });

  /** The tab's thread when it can still take a message, else null (and the link is dropped). */
  async function liveThread(terminalId: string): Promise<string | null> {
    const threadId = links.threadFor(terminalId);
    if (threadId === null) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt === null && thread.deletedAt === null) return threadId;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    await links.drop(terminalId);
    return null;
  }

  async function requireTab(terminalId: string): Promise<void> {
    if (!(await deps.tabs()).some((tab) => tab.terminalId === terminalId)) throw new Error("That terminal tab is closed.");
  }

  return {
    async startAgent(terminalId: string, request: Record<string, unknown>): Promise<{ threadId: string }> {
      await requireTab(terminalId);
      const args = { ...spawnArgs(request, terminalId), visibility: await deps.newChatVisibility() };
      // Another copy of the plugin (a reload) may have saved them: the new thread's first session reads them.
      await deps.loadInstructions().catch(() => undefined);
      await links.begin(terminalId);
      let threadId: string;
      try {
        const spawned = await bb.sdk.threads.spawn(args as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
        threadId = spawned.id;
      } catch (error) {
        await links.drop(terminalId).catch(() => undefined);
        throw error;
      }
      await links.bind(terminalId, threadId);
      return { threadId };
    },

    async askAgent(terminalId: string, text: string): Promise<{ threadId: string }> {
      await requireTab(terminalId);
      const threadId = await liveThread(terminalId);
      if (threadId === null) throw new Error("This terminal has no agent chat any more; start a new one.");
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text }] } as Parameters<typeof bb.sdk.threads.send>[0]);
      return { threadId };
    },

    forgetAgent: (terminalId: string) => links.drop(terminalId),

    /** Makes the tab's chat show in bb's sidebar from now on, for "open in bb"; returns its id. */
    async showAgentChat(terminalId: string): Promise<{ threadId: string }> {
      const threadId = links.threadFor(terminalId);
      if (threadId === null) throw new Error("This terminal has no agent chat.");
      await bb.sdk.threads.update({ threadId, visibility: "visible" });
      return { threadId };
    },

    /** Drops the links of closed tabs, and of threads that were archived or deleted. */
    async prune(): Promise<void> {
      const open = new Set((await deps.tabs()).map((tab) => tab.terminalId));
      for (const link of [...links.all()]) {
        if (!open.has(link.terminalId)) await links.drop(link.terminalId);
        else if (link.threadId !== null) await liveThread(link.terminalId);
        else if (Date.now() - link.createdAt >= PENDING_MS) await links.drop(link.terminalId);
      }
    },
  };
}
