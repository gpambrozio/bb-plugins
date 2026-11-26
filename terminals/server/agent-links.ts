/**
 * Which bb thread helps with which tab: at most one per tab, the one the
 * user started from that tab's agent panel. Only that thread gets the tools
 * that read and type into the tab (server/terminal-agent.ts), and they act
 * on that tab only.
 *
 * A link is stored before the thread exists (`begin`, with no thread id),
 * because bb resolves the new thread's tools while it is still creating it,
 * before `threads.spawn` answers with the id; `bind` fills the id in once it
 * does. A link with no thread is good for `PENDING_MS` only.
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
});

export type AgentLink = z.infer<typeof AgentLinkSchema>;

/** How long a link may wait for the thread bb is creating for it. */
export const PENDING_MS = 60_000;

export interface AgentLinkPorts {
  load(): Promise<AgentLink[]>;
  save(links: AgentLink[]): Promise<void>;
  now(): number;
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

    /** Every link, for pruning. */
    all(): readonly AgentLink[] {
      return links;
    },

    /** Starts a link for the tab, replacing its old one, before its thread exists. */
    begin(terminalId: string): Promise<void> {
      const createdAt = ports.now();
      return update((current) => [...current.filter((link) => link.terminalId !== terminalId), { terminalId, threadId: null, createdAt }]);
    },

    /** Names the thread of the tab's waiting link. */
    bind(terminalId: string, threadId: string): Promise<void> {
      return update((current) => {
        if (!current.some((link) => link.terminalId === terminalId)) return [...current, { terminalId, threadId, createdAt: ports.now() }];
        return current.map((link) => (link.terminalId === terminalId ? { ...link, threadId } : link));
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
