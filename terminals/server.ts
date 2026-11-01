// terminals — the server entry.
//
// Keeps the list of open tabs (bb.storage.kv) and opens and closes the bb
// terminal sessions behind them (bb.sdk.terminals, in the home directory of a
// chosen machine). It runs no shells and relays no output itself: each shell
// runs under that machine's host daemon, and the app streams it straight from
// bb (app/connection.ts). See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { selectableHosts } from "./shared/host-choice";
import { ClosingSchema, TABS_CHANGED, TabSchema, type Closing, type Tab } from "./shared/tabs";
import { createTerminalsService } from "./server/service";
import { newTerminalId } from "./server/terminal-id";

export type { RpcContract } from "./shared/contract";

const TABS_KEY = "tabs";
const CLOSING_KEY = "closing";
/** How often a tab closed while its shell was opening is checked on, while there is one. */
const SETTLE_INTERVAL_MS = 5_000;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

export default async function plugin(bb: BbPluginApi) {
  async function hosts() {
    const [config, all] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
    return selectableHosts(all, config.primaryHostId);
  }

  const service = createTerminalsService({
    load: async () => {
      const stored = await bb.storage.kv.get<unknown>(TABS_KEY);
      const parsed = TabSchema.array().safeParse(stored ?? []);
      if (!parsed.success) {
        bb.log.warn(`ignoring an unreadable tab list: ${parsed.error.message}`);
        return [];
      }
      return parsed.data;
    },
    save: (tabs: Tab[]) => bb.storage.kv.set(TABS_KEY, tabs),
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

  bb.rpc.register(rpcContract, {
    hosts: async () => ({ hosts: await hosts() }),
    list: async () => ({ tabs: await service.list() }),
    open: (input) => service.open(input),
    rename: async ({ terminalId, name }) => {
      await service.rename(terminalId, name);
      return {};
    },
    close: async ({ terminalId }) => {
      await service.close(terminalId);
      wakeSettler();
      return {};
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
