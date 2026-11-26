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
 * bb calls synchronously. Every change is serialized, and works on the list
 * as stored, read again first: on a reload the new copy of the plugin loads
 * before the old one is unloaded, so either may have written since the other
 * last read. Once `close` is called (the copy is being unloaded) nothing is
 * written any more: a change is refused, and `bind` binds nothing. A save the
 * old copy had already sent can still land after the new copy changed the
 * list, so the new copy's `revoke` wins over it rather than relying on the
 * order of writes. No SDK import.
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

/** The refusal of a change asked of a closed store. */
export class LinksClosedError extends Error {
  constructor() {
    super("This copy of the plugin is being unloaded; the newer copy keeps the agent chats.");
  }
}

export function createAgentLinks(ports: AgentLinkPorts) {
  let links: AgentLink[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** Tokens revoked by `revoke`: a link with one is ignored and left out of every save. */
  const revoked = new Set<string>();
  const live = (list: AgentLink[]) => list.filter((link) => !revoked.has(link.token));

  /** Runs after every change before it. */
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  /** Runs `change` on the stored list, read again, after every change before it, and saves what it returns. */
  function update(change: (current: AgentLink[]) => AgentLink[]): Promise<void> {
    return queued(async () => {
      if (closed) throw new LinksClosedError();
      const stored = await ports.load();
      const current = live(stored);
      links = current;
      if (closed) throw new LinksClosedError();
      const changed = change(current);
      // A revoked link another copy's late save put back is written out with this change.
      if (changed === current && current.length === stored.length) return;
      await ports.save(changed);
      links = changed;
    });
  }

  return {
    /** Reads the stored list; call once before the rest. */
    async load(): Promise<void> {
      links = live(await ports.load());
    },

    /**
     * Revokes `tokens` for good in this copy: their links are ignored from
     * now on, even when another copy's save that was already under way (the
     * copy before a reload, binding as it was unloaded) writes one back, and
     * the next change saves the list without them. Links with no token (from
     * before tokens) cannot be revoked.
     */
    revoke(tokens: Iterable<string>): void {
      for (const token of tokens) if (token !== "") revoked.add(token);
      links = live(links);
    },

    /** Reads the stored list again, after the changes queued before it: what another copy of the plugin saved shows. */
    refresh(): Promise<void> {
      return queued(async () => {
        if (!closed) links = live(await ports.load());
      });
    },

    /** Stops every write from this copy; the reads keep answering from memory. */
    close(): void {
      closed = true;
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
     * `token`. False, binding nothing, when that link is gone or was replaced
     * (in storage, by this copy or another), or this copy was closed.
     */
    async bind(terminalId: string, token: string, threadId: string): Promise<boolean> {
      let bound = false;
      try {
        await update((current) => {
          const link = current.find((entry) => entry.terminalId === terminalId);
          if (link === undefined || link.token !== token || link.threadId !== null) return current;
          bound = true;
          return current.map((entry) => (entry === link ? { ...entry, threadId } : entry));
        });
      } catch (error) {
        if (error instanceof LinksClosedError) return false;
        throw error;
      }
      return bound;
    },

    /**
     * Forgets every link still waiting for its thread, and returns their
     * tokens. A new copy of the plugin calls it as it loads: those links were
     * begun by the copy before it, whose spawns can no longer bind (it is
     * being unloaded), so their threads are the new copy's to archive.
     */
    async dropAllPending(): Promise<string[]> {
      const tokens: string[] = [];
      await update((current) => {
        const kept = current.filter((link) => link.threadId !== null);
        for (const link of current) if (link.threadId === null) tokens.push(link.token);
        return kept.length === current.length ? current : kept;
      });
      return tokens;
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

    /** Saves the list without the revoked links a late save of another copy put back. */
    purgeRevoked(): Promise<void> {
      return update((current) => current);
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
