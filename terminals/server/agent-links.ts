/**
 * Which bb thread helps with which tab: at most one per tab, the one the
 * user started from that tab's agent panel. Only that thread gets the tools
 * that read and type into the tab (server/terminal-agent.ts), and they act
 * on that tab only.
 *
 * A link is stored before the thread exists (`begin`, with no thread id),
 * because bb resolves the new thread's tools while it is still creating it,
 * before `threads.spawn` answers with the id; `bind` fills the id in once it
 * does. A link with no thread is good for `PENDING_MS` only. Each `begin`
 * gets a token of its own, and `bind` takes it: a spawn that answers after
 * its link was dropped or replaced (the tab closed, the user let go of the
 * chat, another window started a newer one) binds nothing, and the caller
 * discards its thread.
 *
 * The list is in plugin storage; a copy in memory answers `configure`, which
 * bb calls synchronously. Every change is serialized. No SDK import.
 */
import { z } from "zod";

export const AgentLinkSchema = z.object({
  terminalId: z.string().min(1),
  /** The helper thread, or null while bb is still creating it. */
  threadId: z.string().min(1).nullable(),
  /** When the link was made, which bounds how long it may wait for its thread. */
  createdAt: z.number(),
  /** Which `begin` made the link; links stored before tokens had none. */
  token: z.string().default(""),
});

export type AgentLink = z.infer<typeof AgentLinkSchema>;

/** How long a link may wait for the thread bb is creating for it. */
export const PENDING_MS = 60_000;

export interface AgentLinkPorts {
  load(): Promise<AgentLink[]>;
  save(links: AgentLink[]): Promise<void>;
  now(): number;
  /** A token no other link has had. */
  newToken(): string;
}

export function createAgentLinks(ports: AgentLinkPorts) {
  let links: AgentLink[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `change` on the list after every change before it, and saves what it returns. */
  function update(change: (current: AgentLink[]) => AgentLink[]): Promise<void> {
    const next = queue.then(async () => {
      const changed = change(links);
      if (changed === links) return;
      await ports.save(changed);
      links = changed;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    /** Reads the stored list; call once before the rest. */
    async load(): Promise<void> {
      links = await ports.load();
    },

    /** The tab's bound thread, or null. */
    threadFor(terminalId: string): string | null {
      return links.find((link) => link.terminalId === terminalId)?.threadId ?? null;
    },

    /** The tab `threadId` helps with, or null. */
    terminalFor(threadId: string): string | null {
      return links.find((link) => link.threadId === threadId)?.terminalId ?? null;
    },

    /**
     * Whether `threadId` may have the tab's tools: it is the tab's thread, or
     * the tab is waiting for the thread bb is creating for it.
     */
    mayUse(terminalId: string, threadId: string): boolean {
      const link = links.find((entry) => entry.terminalId === terminalId);
      if (link === undefined) return false;
      if (link.threadId !== null) return link.threadId === threadId;
      return ports.now() - link.createdAt < PENDING_MS;
    },

    /** The token of the tab's link, or null when it has none. */
    tokenFor(terminalId: string): string | null {
      return links.find((link) => link.terminalId === terminalId)?.token ?? null;
    },

    /** Every link, for pruning. */
    all(): readonly AgentLink[] {
      return links;
    },

    /** Starts a link for the tab, replacing its old one, before its thread exists; returns the link's token. */
    async begin(terminalId: string): Promise<string> {
      const createdAt = ports.now();
      const token = ports.newToken();
      await update((current) => [...current.filter((link) => link.terminalId !== terminalId), { terminalId, threadId: null, createdAt, token }]);
      return token;
    },

    /**
     * Names the thread of the tab's waiting link that `begin` made with
     * `token`. False, binding nothing, when that link is gone or was replaced.
     */
    async bind(terminalId: string, token: string, threadId: string): Promise<boolean> {
      let bound = false;
      await update((current) => {
        const link = current.find((entry) => entry.terminalId === terminalId);
        if (link === undefined || link.token !== token || link.threadId !== null) return current;
        bound = true;
        return current.map((entry) => (entry === link ? { ...entry, threadId } : entry));
      });
      return bound;
    },

    /** Forgets the tab's link if `begin` made it with `token` (a spawn that failed); a newer link stays. */
    dropPending(terminalId: string, token: string): Promise<void> {
      return update((current) => {
        const kept = current.filter((link) => !(link.terminalId === terminalId && link.token === token));
        return kept.length === current.length ? current : kept;
      });
    },

    /** Forgets the tab's link; its thread loses the tools from its next session on, and they refuse at once. */
    drop(terminalId: string): Promise<void> {
      return update((current) => {
        const kept = current.filter((link) => link.terminalId !== terminalId);
        return kept.length === current.length ? current : kept;
      });
    },

    /** Forgets every link `keep` says no to. */
    retain(keep: (link: AgentLink) => boolean): Promise<void> {
      return update((current) => {
        const kept = current.filter(keep);
        return kept.length === current.length ? current : kept;
      });
    },
  };
}

export type AgentLinks = ReturnType<typeof createAgentLinks>;
