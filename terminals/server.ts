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
import { TABS_CHANGED, TabSchema, type Tab } from "./shared/tabs";
import { createTerminalsService } from "./server/service";

export type { RpcContract } from "./shared/contract";

const TABS_KEY = "tabs";

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
    hosts,
    createTerminal: ({ hostId, title, cols, rows }) =>
      bb.sdk.terminals.create({
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
    close: async ({ terminalId }) => {
      await service.close(terminalId);
      return {};
    },
  });

  // A shell lives in its machine's host daemon. bb reattaches it after its own
  // server restarts, but a daemon that restarted (a reboot, bb quit on that
  // machine) took its shells with it, and a shell may have exited while no app
  // was open. Drop the tabs of ended shells once per load.
  bb.background.service("prune-ended-tabs", {
    async start(signal) {
      try {
        await service.prune();
      } catch (error) {
        bb.log.warn(`could not drop ended tabs: ${String(error)}`);
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
