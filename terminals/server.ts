// terminals — the server entry.
//
// Keeps the list of open tabs (bb.storage.kv) and opens and closes the bb
// terminal sessions behind them (bb.sdk.terminals, in the home directory of a
// chosen machine). It runs no shells and relays no output itself: each shell
// runs under that machine's host daemon, and the app streams it straight from
// bb (app/connection.ts). See AGENTS.md.
import { randomUUID } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AGENT_TYPED, MAX_INSTRUCTIONS_LENGTH, normalizeInstructions, type AgentTyped } from "./shared/agent";
import { rpcContract } from "./shared/contract";
import { selectableHosts } from "./shared/host-choice";
import { ClosingSchema, TABS_CHANGED, TabSchema, type Closing, type Tab } from "./shared/tabs";
import { registerAgent } from "./server/agent";
import { setAllChats, settleChats, type ChatVisibilityPorts } from "./server/chat-visibility";
import { createAgentCommands } from "./server/agent-commands";
import { AgentLinkSchema, createAgentLinks } from "./server/agent-links";
import { createTerminalsService } from "./server/service";
import type { AgentTerminalPorts } from "./server/terminal-agent";
import { newTerminalId } from "./server/terminal-id";

export type { RpcContract } from "./shared/contract";

const TABS_KEY = "tabs";
const CLOSING_KEY = "closing";
const AGENTS_KEY = "agents";
/** Set once the agent chats started before chats were hidden have been hidden. */
const HIDDEN_MIGRATION_KEY = "agentChatsHidden";
/** The owner's instructions text for a tab's agent; absent means the built-in one. */
const INSTRUCTIONS_KEY = "agentInstructions";
/** How often a tab closed while its shell was opening is checked on, while there is one. */
const SETTLE_INTERVAL_MS = 5_000;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  async function hosts() {
    const [config, all] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
    return selectableHosts(all, config.primaryHostId);
  }

  /** The tabs as last read or written, for what cannot wait for storage (`agents.configure`). */
  let cachedTabs: readonly Tab[] = [];
  async function loadTabs(): Promise<Tab[]> {
    const stored = await bb.storage.kv.get<unknown>(TABS_KEY);
    const parsed = TabSchema.array().safeParse(stored ?? []);
    if (!parsed.success) {
      bb.log.warn(`ignoring an unreadable tab list: ${parsed.error.message}`);
      return [];
    }
    cachedTabs = parsed.data;
    return parsed.data;
  }

  const service = createTerminalsService({
    load: loadTabs,
    save: async (tabs: Tab[]) => {
      await bb.storage.kv.set(TABS_KEY, tabs);
      cachedTabs = tabs;
    },
    loadClosing: async () => {
      const parsed = ClosingSchema.array().safeParse((await bb.storage.kv.get<unknown>(CLOSING_KEY)) ?? []);
      if (!parsed.success) {
        bb.log.warn(`ignoring an unreadable list of closing tabs: ${parsed.error.message}`);
        return [];
      }
      return parsed.data;
    },
    saveClosing: (closing: Closing[]) => bb.storage.kv.set(CLOSING_KEY, closing),
    hosts,
    newTerminalId: () => newTerminalId(),
    createTerminal: ({ terminalId, hostId, title, cols, rows }) =>
      bb.sdk.terminals.create({
        id: terminalId,
        // A null cwd is the host's home directory, as a new window in a terminal app.
        scope: { kind: "host_path", hostId, cwd: null },
        start: { mode: "shell" },
        title,
        cols,
        rows,
      }),
    getTerminal: async (terminalId) => {
      try {
        return await bb.sdk.terminals.get({ terminalId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    renameTerminal: async (terminalId, title) => {
      await bb.sdk.terminals.rename({ terminalId, title: title.trim() === "" ? "Terminal" : title });
    },
    closeTerminal: async (terminalId) => {
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
    },
    publish: () => bb.realtime.publish(TABS_CHANGED, {}),
    now: () => Date.now(),
    warn: (message) => bb.log.warn(message),
  });

  const links = createAgentLinks({
    load: async () => {
      const parsed = AgentLinkSchema.array().safeParse((await bb.storage.kv.get<unknown>(AGENTS_KEY)) ?? []);
      if (!parsed.success) {
        bb.log.warn(`ignoring an unreadable list of agent chats: ${parsed.error.message}`);
        return [];
      }
      return parsed.data;
    },
    save: (list) => bb.storage.kv.set(AGENTS_KEY, list),
    now: () => Date.now(),
    newToken: () => randomUUID(),
  });
  await links.load();
  await loadTabs().catch(() => []);

  const terminalPorts: AgentTerminalPorts = {
    session: async (terminalId) => {
      try {
        return await bb.sdk.terminals.get({ terminalId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    output: (args) => bb.sdk.terminals.output(args),
    input: async (terminalId, data) => {
      await bb.sdk.terminals.input({ terminalId, dataBase64: Buffer.from(data, "utf8").toString("base64") });
    },
    announce: (terminalId, command) => {
      // Stored first, so a window that reads the list on this signal finds the command.
      const payload: AgentTyped = { terminalId, command };
      void agent
        .noteTyped(terminalId, command, Date.now())
        .catch((error: unknown) => bb.log.warn(`could not keep the command the agent ran: ${String(error)}`))
        .finally(() => bb.realtime.publish(AGENT_TYPED, payload));
    },
    sleep,
    now: () => Date.now(),
  };
  const settings = bb.settings.define({
    alwaysShowAgentChats: {
      type: "boolean",
      label: "Always show agent chats in the sidebar",
      description:
        "Off: a terminal's agent chat stays out of bb's sidebar until you open it as a normal thread from its panel. bb sends no push notifications for a chat while it is hidden, and leaves it out of @-mentions and thread lists. On: every agent chat shows in the sidebar, with notifications, and the hidden ones are shown now.",
      default: false,
    },
  });
  const visibilityPorts: ChatVisibilityPorts = {
    list: (offset, limit) =>
      bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false, offset, limit }),
    update: async (threadId, visibility) => {
      await bb.sdk.threads.update({ threadId, visibility });
    },
    warn: (text) => bb.log.warn(text),
  };
  settings.onChange((next, prev) => {
    if (next.alwaysShowAgentChats && !prev.alwaysShowAgentChats) {
      setAllChats(visibilityPorts, "visible").catch((error: unknown) => bb.log.warn(`could not show the agent chats: ${String(error)}`));
    }
  });

  let cachedInstructions: string | null = null;
  const loadInstructions = async () => {
    const stored = await bb.storage.kv.get<unknown>(INSTRUCTIONS_KEY);
    cachedInstructions = typeof stored === "string" ? normalizeInstructions(stored.slice(0, MAX_INSTRUCTIONS_LENGTH)) : null;
    return cachedInstructions;
  };
  await loadInstructions().catch((error: unknown) => bb.log.warn(`could not read the agent instructions: ${String(error)}`));

  const agentCommands = createAgentCommands({
    get: (key) => bb.storage.kv.get<unknown>(key),
    set: (key, value) => bb.storage.kv.set(key, value),
    delete: (key) => bb.storage.kv.delete(key),
    list: (prefix) => bb.storage.kv.list(prefix),
  });
  const agent = registerAgent(bb, {
    commands: agentCommands,
    cachedInstructions: () => cachedInstructions,
    loadInstructions,
    newChatVisibility: async () => ((await settings.get()).alwaysShowAgentChats ? "visible" : "hidden"),
    links,
    tabs: loadTabs,
    cachedTabs: () => cachedTabs,
    ports: terminalPorts,
    sleep: (ms) => sleep(ms),
  });

  bb.rpc.register(rpcContract, {
    hosts: async () => ({ hosts: await hosts() }),
    list: async () => ({
      tabs: (await service.list()).map((tab) => ({ ...tab, agentThreadId: links.threadFor(tab.terminalId) })),
    }),
    open: (input) => service.open(input),
    rename: async ({ terminalId, name }) => {
      await service.rename(terminalId, name);
      return {};
    },
    move: async ({ terminalId, toTerminalId }) => {
      await service.move(terminalId, toTerminalId);
      return {};
    },
    close: async ({ terminalId }) => {
      await service.close(terminalId);
      wakeSettler();
      await agent.forgetAgent(terminalId);
      return {};
    },
    startAgent: async ({ terminalId, request }) => {
      const result = await agent.startAgent(terminalId, request);
      bb.realtime.publish(TABS_CHANGED, {});
      return result;
    },
    askAgent: ({ terminalId, text }) => agent.askAgent(terminalId, text),
    forgetAgent: async ({ terminalId }) => {
      await agent.forgetAgent(terminalId);
      bb.realtime.publish(TABS_CHANGED, {});
      return {};
    },
    showAgentChat: ({ terminalId }) => agent.showAgentChat(terminalId),
    agentCommands: ({ terminalId }) => agent.agentCommands(terminalId),
    agentInstructions: async () => ({ text: await loadInstructions() }),
    setAgentInstructions: async ({ text }) => {
      const next = normalizeInstructions(text);
      if (next === null) await bb.storage.kv.delete(INSTRUCTIONS_KEY);
      else await bb.storage.kv.set(INSTRUCTIONS_KEY, next);
      cachedInstructions = next;
      return { text: next };
    },
  });

  /** Wakes the service below early, after a close that may have left a record. */
  let wakeSettler: () => void = () => undefined;

  // A shell lives in its machine's host daemon. bb reattaches it after its own
  // server restarts, but a daemon that restarted (a reboot, bb quit on that
  // machine) took its shells with it, and a shell may have exited while no app
  // was open. Drop the tabs of ended shells once per load. Then end the shells
  // of tabs closed before bb had made them — the record of those outlives a
  // reload, so a shell bb finishes making after it is still ended — checking
  // every few seconds while there are any.
  bb.background.service("prune-ended-tabs", {
    async start(signal) {
      try {
        await service.prune();
      } catch (error) {
        bb.log.warn(`could not drop ended tabs: ${String(error)}`);
      }
      try {
        await agent.prune();
      } catch (error) {
        bb.log.warn(`could not let go of finished agent chats: ${String(error)}`);
      }
      try {
        await settleChats(
          visibilityPorts,
          {
            alwaysShow: (await settings.get()).alwaysShowAgentChats,
            migrated: async () => (await bb.storage.kv.get<unknown>(HIDDEN_MIGRATION_KEY)) === true,
            markMigrated: () => bb.storage.kv.set(HIDDEN_MIGRATION_KEY, true),
          },
          signal,
        );
      } catch (error) {
        bb.log.warn(`could not set which agent chats show in the sidebar: ${String(error)}`);
      }
      while (!signal.aborted) {
        let pending: boolean;
        try {
          pending = await service.settleClosing();
        } catch (error) {
          bb.log.warn(`could not check on tabs closed while opening: ${String(error)}`);
          pending = true;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wakeSettler = () => undefined;
            resolve();
          };
          const timer = pending ? setTimeout(done, SETTLE_INTERVAL_MS) : undefined;
          wakeSettler = done;
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    },
  });
}
