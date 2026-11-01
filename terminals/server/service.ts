/**
 * The tab list and the shells behind it. Plain logic over injected ports, so
 * it runs against fakes in tests (service.test.ts) and against bb in server.ts.
 *
 * The shells are bb's own terminal sessions (`bb.sdk.terminals`), run by the
 * host daemon of the chosen machine and buffered by bb, so they keep running
 * and keep their output whatever the app does. This file only remembers which
 * sessions are tabs, in which order.
 */
import { MAX_TABS, OPENING_GRACE_MS, normalizeTabName, tabStatus, type Closing, type HostChoice, type Tab, type TabView } from "../shared/tabs";

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
  /** Tabs closed before bb had made their shell ([] when there are none); see `ClosingSchema`. */
  loadClosing(): Promise<Closing[]>;
  saveClosing(closing: Closing[]): Promise<void>;
  /** The machines a shell can open on now (`shared/host-choice.ts`). */
  hosts(): Promise<HostChoice[]>;
  /** A new id for bb's next terminal (`server/terminal-id.ts`). */
  newTerminalId(): string;
  /** Starts a login shell in the home directory of `hostId`, under the given id. */
  createTerminal(args: { terminalId: string; hostId: string; title: string; cols: number; rows: number }): Promise<TerminalSessionInfo>;
  /** The session, or null when bb no longer knows it. */
  getTerminal(terminalId: string): Promise<TerminalSessionInfo | null>;
  /** Sets bb's own title for the session (what `bb terminal list` shows). */
  renameTerminal(terminalId: string, title: string): Promise<void>;
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
  /** Names the tab; an empty name or null brings back its default title. */
  rename(terminalId: string, name: string | null): Promise<void>;
  close(terminalId: string): Promise<void>;
  /** Drops the tabs whose shell has ended; a tab still opening stays. */
  prune(): Promise<void>;
  /**
   * Ends the shells of tabs closed before bb had made them, once bb has them;
   * true while some may still be on their way.
   */
  settleClosing(): Promise<boolean>;
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
    // A new tab is stored before bb makes its shell (see open): give bb time before calling it ended.
    if (session === null && ports.now() - tab.createdAt < OPENING_GRACE_MS) {
      return { ...tab, status: "opening", exitCode: null };
    }
    return { ...tab, status: tabStatus(session), exitCode: session?.exitCode ?? null };
  }

  /** Removes the tab from the stored list; true when it was there. */
  function removeTab(terminalId: string): Promise<boolean> {
    return serialized(async () => {
      const tabs = await ports.load();
      const rest = tabs.filter((tab) => tab.terminalId !== terminalId);
      if (rest.length === tabs.length) return false;
      await ports.save(rest);
      return true;
    });
  }

  return {
    async list() {
      const tabs = await ports.load();
      return Promise.all(tabs.map(view));
    },

    async open({ hostId, cols, rows }) {
      const host = (await ports.hosts()).find((entry) => entry.id === hostId);
      if (host === undefined) throw new Error("That machine is not connected to bb.");
      const tab: Tab = { terminalId: ports.newTerminalId(), hostId, hostName: host.name, createdAt: ports.now(), name: null };
      // The tab is stored before its shell exists, under the id bb will give the shell. So a shell
      // never runs without a tab — not even when this copy of the plugin is reloaded or disabled
      // while bb is still starting it — and a stored tab holds its place under the limit while
      // other opens check it.
      await serialized(async () => {
        const tabs = await ports.load();
        if (tabs.length >= MAX_TABS) throw new Error(`At most ${MAX_TABS} terminals can be open; close one first.`);
        await ports.save([...tabs, tab]);
      });
      let session: TerminalSessionInfo;
      try {
        session = await ports.createTerminal({ terminalId: tab.terminalId, hostId, title: host.name, cols, rows });
      } catch (error) {
        try {
          if (await removeTab(tab.terminalId)) ports.publish();
        } catch (removeError) {
          // The tab shows as ended once its grace runs out, and the next load drops it.
          ports.warn(`could not drop the tab of terminal ${tab.terminalId}, which failed to open: ${String(removeError)}`);
        }
        throw error;
      }
      // Closed while bb was starting it: end the shell no tab points at any more.
      const stillOpen = await serialized(async () => (await ports.load()).some((entry) => entry.terminalId === tab.terminalId));
      if (!stillOpen) {
        await ports.closeTerminal(session.id).catch((closeError: unknown) => {
          ports.warn(`could not end terminal ${session.id}, whose tab was closed while it opened: ${String(closeError)}`);
        });
        throw new Error("That tab was closed while it was opening.");
      }
      ports.publish();
      return { ...tab, status: tabStatus(session), exitCode: session.exitCode };
    },

    async rename(terminalId, name) {
      const normalized = normalizeTabName(name);
      const renamed = await serialized(async () => {
        const tabs = await ports.load();
        const tab = tabs.find((entry) => entry.terminalId === terminalId);
        if (tab === undefined) throw new Error("That tab is closed.");
        if (tab.name === normalized) return null;
        await ports.save(tabs.map((entry) => (entry === tab ? { ...entry, name: normalized } : entry)));
        return tab;
      });
      if (renamed === null) return;
      ports.publish();
      // bb's own title follows, so `bb terminal list` says the same; the tab's name is what counts.
      await ports.renameTerminal(terminalId, normalized ?? renamed.hostName).catch((error: unknown) => {
        ports.warn(`could not retitle terminal ${terminalId}: ${String(error)}`);
      });
    },

    async close(terminalId) {
      // End the shell first: if that fails, the tab stays, so the shell is never left without one.
      let unknownToBb = false;
      try {
        await ports.closeTerminal(terminalId);
      } catch (error) {
        // bb refuses to close a session that has already ended or is gone; that is the outcome asked for.
        const session = await ports.getTerminal(terminalId).catch(() => undefined);
        if (session === undefined || (session !== null && session.status !== "exited")) throw error;
        unknownToBb = session === null;
      }
      const removed = await serialized(async () => {
        const tabs = await ports.load();
        const tab = tabs.find((entry) => entry.terminalId === terminalId);
        if (tab === undefined) return false;
        // bb has no shell for it, but one may still be on its way (the tab was stored first): keep
        // a record that outlives this copy of the plugin, so whichever copy is loaded ends it.
        if (unknownToBb && ports.now() - tab.createdAt < OPENING_GRACE_MS) {
          const closing = await ports.loadClosing();
          if (!closing.some((entry) => entry.terminalId === terminalId)) {
            await ports.saveClosing([...closing, { terminalId, createdAt: tab.createdAt }]);
          }
        }
        await ports.save(tabs.filter((entry) => entry !== tab));
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

    async settleClosing() {
      const records = await ports.loadClosing();
      if (records.length === 0) return false;
      const settled = new Set<string>();
      for (const record of records) {
        try {
          const session = await ports.getTerminal(record.terminalId);
          if (session === null) {
            // Past the grace bb never made it; before, it may still come.
            if (ports.now() - record.createdAt >= OPENING_GRACE_MS) settled.add(record.terminalId);
            continue;
          }
          if (session.status !== "exited") await ports.closeTerminal(record.terminalId);
          settled.add(record.terminalId);
        } catch (error) {
          ports.warn(`could not end terminal ${record.terminalId}, whose tab was closed while it opened: ${String(error)}`);
        }
      }
      const left = await serialized(async () => {
        const rest = (await ports.loadClosing()).filter((entry) => !settled.has(entry.terminalId));
        if (settled.size > 0) await ports.saveClosing(rest);
        return rest.length;
      });
      return left > 0;
    },
  };
}
