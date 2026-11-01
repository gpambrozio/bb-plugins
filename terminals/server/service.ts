/**
 * The tab list and the shells behind it. Plain logic over injected ports, so
 * it runs against fakes in tests (service.test.ts) and against bb in server.ts.
 *
 * The shells are bb's own terminal sessions (`bb.sdk.terminals`), run by the
 * host daemon of the chosen machine and buffered by bb, so they keep running
 * and keep their output whatever the app does. This file only remembers which
 * sessions are tabs, in which order.
 */
import { MAX_TABS, tabStatus, type HostChoice, type Tab, type TabView } from "../shared/tabs";

/** The fields of a bb terminal session this file reads. */
export interface TerminalSessionInfo {
  id: string;
  status: "starting" | "running" | "disconnected" | "exited";
  exitCode: number | null;
}

export interface TerminalsPorts {
  /** The stored tabs, in opening order; [] before the first one. */
  load(): Promise<Tab[]>;
  save(tabs: Tab[]): Promise<void>;
  /** The machines a shell can open on now (`shared/host-choice.ts`). */
  hosts(): Promise<HostChoice[]>;
  /** Starts a login shell in the home directory of `hostId`. */
  createTerminal(args: { hostId: string; title: string; cols: number; rows: number }): Promise<TerminalSessionInfo>;
  /** The session, or null when bb no longer knows it. */
  getTerminal(terminalId: string): Promise<TerminalSessionInfo | null>;
  /** Ends the shell, or throws (bb throws for a session that has already ended, too). */
  closeTerminal(terminalId: string): Promise<void>;
  /** Tells every client the tab list changed. */
  publish(): void;
  now(): number;
  warn(message: string): void;
}

export interface TerminalsService {
  list(): Promise<TabView[]>;
  open(args: { hostId: string; cols: number; rows: number }): Promise<TabView>;
  close(terminalId: string): Promise<void>;
  /** Drops the tabs whose shell has ended — after a bb server restart, every one. */
  prune(): Promise<void>;
}

export function createTerminalsService(ports: TerminalsPorts): TerminalsService {
  /**
   * Every read-modify-write of the stored list runs here, one after another,
   * so two clients opening tabs at once both land.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function view(tab: Tab): Promise<TabView> {
    let session: TerminalSessionInfo | null;
    try {
      session = await ports.getTerminal(tab.terminalId);
    } catch (error) {
      // An unreadable session is not an ended one: show it as offline and let the socket say more.
      ports.warn(`could not read terminal ${tab.terminalId}: ${String(error)}`);
      return { ...tab, status: "disconnected", exitCode: null };
    }
    return { ...tab, status: tabStatus(session), exitCode: session?.exitCode ?? null };
  }

  return {
    async list() {
      const tabs = await ports.load();
      return Promise.all(tabs.map(view));
    },

    async open({ hostId, cols, rows }) {
      const host = (await ports.hosts()).find((entry) => entry.id === hostId);
      if (host === undefined) throw new Error("That machine is not connected to bb.");
      if ((await ports.load()).length >= MAX_TABS) {
        throw new Error(`At most ${MAX_TABS} terminals can be open; close one first.`);
      }
      const session = await ports.createTerminal({ hostId, title: host.name, cols, rows });
      const tab: Tab = { terminalId: session.id, hostId, hostName: host.name, createdAt: ports.now() };
      try {
        await serialized(async () => ports.save([...(await ports.load()), tab]));
      } catch (error) {
        // A shell no tab points at would run until bb restarts; end it.
        await ports.closeTerminal(session.id).catch((closeError: unknown) => {
          ports.warn(`could not end terminal ${session.id} after failing to save its tab: ${String(closeError)}`);
        });
        throw error;
      }
      ports.publish();
      return { ...tab, status: tabStatus(session), exitCode: session.exitCode };
    },

    async close(terminalId) {
      // End the shell first: if that fails, the tab stays, so the shell is never left without one.
      try {
        await ports.closeTerminal(terminalId);
      } catch (error) {
        // bb refuses to close a session that has already ended or is gone; that is the outcome asked for.
        const session = await ports.getTerminal(terminalId).catch(() => undefined);
        if (session === undefined || (session !== null && session.status !== "exited")) throw error;
      }
      const removed = await serialized(async () => {
        const tabs = await ports.load();
        const rest = tabs.filter((tab) => tab.terminalId !== terminalId);
        if (rest.length === tabs.length) return false;
        await ports.save(rest);
        return true;
      });
      if (removed) ports.publish();
    },

    async prune() {
      const tabs = await ports.load();
      const views = await Promise.all(tabs.map(view));
      const ended = new Set(views.filter((tab) => tab.status === "ended").map((tab) => tab.terminalId));
      if (ended.size === 0) return;
      await serialized(async () => ports.save((await ports.load()).filter((tab) => !ended.has(tab.terminalId))));
      ports.publish();
    },
  };
}
