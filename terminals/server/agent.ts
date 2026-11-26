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
import type { AgentCommands } from "./agent-commands";
import { PENDING_MS, type AgentLinks } from "./agent-links";
import {
  MAX_READ_LINES,
  MAX_RUN_TIMEOUT_MS,
  TerminalToolError,
  readTerminal,
  runCommand,
  TerminalLocks,
  type AgentTerminalPorts,
  type TabFacts,
} from "./terminal-agent";

/** The metadata key naming the tab a helper thread was started for. */
export const TERMINAL_METADATA_KEY = "terminalId";
/** The metadata key holding the token of the link a thread's spawn began (server/agent-links.ts). */
export const SPAWN_METADATA_KEY = "agentSpawn";
/** Storage key: the tokens of spawns a copy of the plugin revoked, whose threads are archived on sight. */
const REVOKED_KEY = "revokedAgentSpawns";
/** How long a revoked token is kept: a spawn answers well within it. */
const REVOKED_KEEP_MS = 24 * 60 * 60 * 1000;
const RevokedSchema = z.array(z.object({ token: z.string(), at: z.number() }));

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
export function spawnArgs(request: Record<string, unknown>, terminalId: string, token: string): Record<string, unknown> {
  if (typeof request.projectId !== "string" || request.projectId === "") throw new Error("The request names no project.");
  if (!Array.isArray(request.input) || request.input.length === 0) throw new Error("The request has no message.");
  if (typeof request.environment !== "object" || request.environment === null) throw new Error("The request names no environment.");
  const args: Record<string, unknown> = {};
  for (const field of REQUEST_FIELDS) if (request[field] !== undefined) args[field] = request[field];
  args.pluginMetadata = { [TERMINAL_METADATA_KEY]: terminalId, [SPAWN_METADATA_KEY]: token };
  return args;
}

export interface AgentDeps {
  links: AgentLinks;
  /** The commands each tab's chat typed into it. */
  commands: AgentCommands;
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

const DETACHED =
  "This chat is not connected to a terminal any more: the user started another chat for it, let go of it, or closed its tab.";

export function registerAgent(bb: BbPluginApi, deps: AgentDeps) {
  const { links } = deps;
  /** One command at a time per tab, from whichever chat. */
  const locks = new TerminalLocks();
  /** Set once this copy of the plugin is unloaded: a spawn that answers after that is discarded. */
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
    // The newer copy, loaded before this one is unloaded, keeps the links from now on.
    links.close();
  });

  /**
   * A check that the chat still has the tab, as it had it when the call began:
   * the same link (by token), still naming this thread. A new chat for the
   * tab, letting go of it or closing the tab makes it throw.
   */
  function accessCheck(threadId: string, terminalId: string): () => void {
    const token = links.tokenFor(terminalId);
    return () => {
      if (disposed || links.terminalFor(threadId) !== terminalId || links.tokenFor(terminalId) !== token) {
        throw new TerminalToolError(DETACHED);
      }
    };
  }

  /** The tab the calling thread helps with, waiting a little for a spawn that has not answered yet. */
  async function tabForThread(threadId: string, signal: AbortSignal): Promise<TabFacts> {
    const deadline = Date.now() + BIND_WAIT_MS;
    let terminalId = links.terminalFor(threadId);
    if (terminalId === null) {
      // Another copy of the plugin (the one before a reload) may have bound it since this one read the links.
      await links.refresh();
      terminalId = links.terminalFor(threadId);
    }
    while (terminalId === null && Date.now() < deadline && !signal.aborted) {
      const pending = links.all().some((link) => link.threadId === null);
      if (!pending) break;
      await deps.sleep(200);
      await links.refresh();
      terminalId = links.terminalFor(threadId);
    }
    if (terminalId === null) throw new TerminalToolError(DETACHED);
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
      "Type one command into the user's terminal tab (the one this chat was started from), run it in their shell, and wait for it: returns what it printed and its exit code. The user sees it run. Types only at an empty shell prompt the terminal plainly shows, and presses Enter only once the shell echoed the command; refuses (saying why and how to fix it) while a command runs, a program or full-screen app has the terminal, or the user has typed something at the prompt.",
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
      asTool(async () => {
        const tab = await tabForThread(ctx.threadId, ctx.signal);
        return runCommand(
          deps.ports,
          tab,
          { command, ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }) },
          { signal: ctx.signal, checkAccess: accessCheck(ctx.threadId, tab.terminalId), locks },
        );
      }),
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

  /**
   * Spawns the copy of the plugin before this one began and can no longer
   * bind (it is unloaded, and bb refuses its calls, so it cannot archive
   * their threads itself). Their threads are archived when bb reports them
   * created, and by the sweep in `prune`.
   */
  let revoked = new Map<string, number>();

  async function saveRevoked(): Promise<void> {
    const now = Date.now();
    for (const [token, at] of revoked) if (now - at >= REVOKED_KEEP_MS) revoked.delete(token);
    await bb.storage.kv.set(REVOKED_KEY, [...revoked].map(([token, at]) => ({ token, at })));
  }

  async function spawnToken(threadId: string): Promise<string | null> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    const token = metadata[SPAWN_METADATA_KEY];
    return typeof token === "string" ? token : null;
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.originPluginId !== bb.pluginId || revoked.size === 0) return;
    try {
      const token = await spawnToken(thread.id);
      if (token !== null && revoked.has(token)) await discardThread(thread.id);
    } catch (error) {
      bb.log.warn(`could not check a new agent chat ${thread.id}: ${errorText(error)}`);
    }
  });

  /** Archives the threads of revoked spawns that are still open. */
  async function sweepRevoked(): Promise<void> {
    if (revoked.size === 0) return;
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false, offset, limit: 100 });
      ids.push(...page.map((thread) => thread.id));
      if (page.length < 100) break;
    }
    for (let index = 0; index < ids.length; index += 200) {
      const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: ids.slice(index, index + 200) });
      for (const { threadId, metadata } of threads) {
        const token = metadata[SPAWN_METADATA_KEY];
        // Even when a late save of the copy before linked it: `links.revoke` ignores that link.
        if (typeof token === "string" && revoked.has(token)) await discardThread(threadId);
      }
    }
  }

  /** Stops and archives a chat no tab will use; a failure is logged, not thrown. */
  async function discardThread(threadId: string): Promise<void> {
    // bb refuses an unloaded copy's calls; the newer copy archives the thread (see `revoked`).
    if (disposed) return;
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (error) {
      if (!isGone(error)) bb.log.warn(`could not stop an unused agent chat ${threadId}: ${errorText(error)}`);
    }
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch (error) {
      if (!isGone(error)) bb.log.warn(`could not archive an unused agent chat ${threadId}: ${errorText(error)}`);
    }
  }

  async function requireTab(terminalId: string): Promise<void> {
    if (!(await deps.tabs()).some((tab) => tab.terminalId === terminalId)) throw new Error("That terminal tab is closed.");
  }

  return {
    /**
     * Run once as this copy loads: revokes the links the copy before it left
     * waiting for a thread, and reads the tokens revoked before.
     */
    async start(): Promise<void> {
      const parsed = RevokedSchema.safeParse((await bb.storage.kv.get<unknown>(REVOKED_KEY)) ?? []);
      revoked = new Map(parsed.success ? parsed.data.map((entry) => [entry.token, entry.at]) : []);
      links.revoke(revoked.keys());
      const dropped = (await links.dropAllPending()).filter((token) => token !== "");
      for (const token of dropped) revoked.set(token, Date.now());
      // The copy before may be saving a bind of one of them right now; it is ignored whenever it lands.
      links.revoke(dropped);
      if (dropped.length > 0 || !parsed.success) await saveRevoked();
    },

    async startAgent(terminalId: string, request: Record<string, unknown>): Promise<{ threadId: string }> {
      await requireTab(terminalId);
      // Checks the request before a link is begun for it.
      spawnArgs(request, terminalId, "");
      const visibility = await deps.newChatVisibility();
      // Another copy of the plugin (a reload) may have saved them: the new thread's first session reads them.
      await deps.loadInstructions().catch(() => undefined);
      const token = await links.begin(terminalId);
      const args = { ...spawnArgs(request, terminalId, token), visibility };
      let threadId: string;
      try {
        const spawned = await bb.sdk.threads.spawn(args as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
        threadId = spawned.id;
      } catch (error) {
        await links.dropPending(terminalId, token).catch(() => undefined);
        throw error;
      }
      // While bb created the thread, the tab may have closed, the user let go of the chat,
      // another window started a newer one, or this copy of the plugin was unloaded.
      const tabOpen = !disposed && (await deps.tabs().then((tabs) => tabs.some((tab) => tab.terminalId === terminalId)).catch(() => false));
      // Unloaded while the tabs were read: the links are the newer copy's now, and this one writes none.
      const bound = tabOpen && !disposed && (await links.bind(terminalId, token, threadId));
      if (!bound) {
        if (!disposed && !tabOpen) await links.dropPending(terminalId, token).catch(() => undefined);
        await discardThread(threadId);
        throw new Error(
          disposed
            ? "The Terminals plugin was reloaded while this chat was starting; the chat was stopped and archived. Start it again."
            : tabOpen
            ? "While this chat was starting, another one was started for this terminal or its chat was let go of; this one was stopped and archived."
            : "The terminal tab closed while its chat was starting; the chat was stopped and archived.",
        );
      }
      // A new chat for the tab: the last one's commands go with it.
      await deps.commands.clear(terminalId).catch(() => undefined);
      return { threadId };
    },

    async askAgent(terminalId: string, text: string): Promise<{ threadId: string }> {
      await requireTab(terminalId);
      const threadId = await liveThread(terminalId);
      if (threadId === null) throw new Error("This terminal has no agent chat any more; start a new one.");
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text }] } as Parameters<typeof bb.sdk.threads.send>[0]);
      return { threadId };
    },

    /** The owner lets go of the tab's chat (a new chat, or the tab closed): its link and its commands go. */
    async forgetAgent(terminalId: string): Promise<void> {
      await links.drop(terminalId);
      await deps.commands.clear(terminalId);
    },

    /** The commands the tab's chat typed into it, oldest first, and that chat's id. */
    async agentCommands(terminalId: string): Promise<{ threadId: string | null; commands: { command: string; at: number }[] }> {
      const threadId = links.threadFor(terminalId);
      return { threadId, commands: await deps.commands.list(terminalId, threadId) };
    },

    /** Records a command the tab's chat typed, before the page is told. */
    async noteTyped(terminalId: string, command: string, at: number): Promise<void> {
      const threadId = links.threadFor(terminalId);
      if (threadId !== null) await deps.commands.append(terminalId, threadId, command, at);
    },

    /** Makes the tab's chat show in bb's sidebar from now on, for "open in bb"; returns its id. */
    async showAgentChat(terminalId: string): Promise<{ threadId: string }> {
      const threadId = links.threadFor(terminalId);
      if (threadId === null) throw new Error("This terminal has no agent chat.");
      await bb.sdk.threads.update({ threadId, visibility: "visible" });
      return { threadId };
    },

    /** Drops the links of closed tabs, and of threads that were archived or deleted. */
    async prune(): Promise<void> {
      await links.refresh();
      await sweepRevoked().catch((error: unknown) => bb.log.warn(`could not archive the agent chats a reload left behind: ${errorText(error)}`));
      await links.purgeRevoked();
      const open = new Set((await deps.tabs()).map((tab) => tab.terminalId));
      for (const link of [...links.all()]) {
        if (!open.has(link.terminalId)) await links.drop(link.terminalId);
        else if (link.threadId !== null) await liveThread(link.terminalId);
        else if (Date.now() - link.createdAt >= PENDING_MS) await links.drop(link.terminalId);
      }
      await deps.commands.retain((terminalId, threadId) => links.threadFor(terminalId) === threadId);
    },
  };
}
