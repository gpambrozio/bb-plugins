/**
 * What the briefing reads from bb, as a narrow interface: `sdk-ports.ts` implements it over `bb.sdk`, and
 * the tests implement it in memory. Every method only reads.
 */
import type { FleetData } from "./firstmate";
import type { RequestEvent } from "./messages";

export interface ThreadRow {
  id: string;
  title: string | null;
  titleFallback: string | null;
  projectId: string;
  parentThreadId: string | null;
  archivedAt: number | null;
  /** bb's `runtime.displayStatus`. */
  status: string;
  hasPendingInteraction: boolean;
  updatedAt: number;
  /** The machine and folder of its workspace, when it has one. */
  hostId: string | null;
  path: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  /** Its checkouts, the default one first. */
  sources: { hostId: string; path: string }[];
}

export type FleetRead = { ok: true; fleet: FleetData } | { ok: false; reason: string };

/**
 * One file read inside a folder: its text, not there, or refused for this file alone (it resolves outside
 * the folder, is too large, cannot be opened). A machine that cannot be read throws instead.
 */
export type FileRead = { kind: "text"; text: string } | { kind: "missing" } | { kind: "refused"; reason: string };

export interface BriefingPorts {
  /** Every thread with no parent that is not archived or hidden; `complete` is false when a cap cut the list. */
  rootThreads(): Promise<{ threads: ThreadRow[]; complete: boolean }>;
  /** The ids below each of `rootIds`, at any depth, archived and hidden ones left out. */
  descendants(rootIds: readonly string[]): Promise<Map<string, string[]>>;
  /** These threads' rows (up to any number; the implementation pages). */
  threads(ids: readonly string[]): Promise<ThreadRow[]>;
  thread(id: string): Promise<ThreadRow | null>;
  /** Every project, the personal one included. */
  projects(): Promise<ProjectRow[]>;
  /**
   * A page of the thread's `client/turn/requested` events. `asc` reads from the start, `desc` from the
   * end; `beforeSeq` continues a `desc` read.
   */
  requests(threadId: string, order: "asc" | "desc", limit: number, beforeSeq?: number): Promise<RequestEvent[]>;
  /** The preview of the thread's latest agent message (bb's conversation outline; at most 200 characters). */
  lastAgentPreview(threadId: string): Promise<string | null>;
  /** The full text of the thread's latest reply: its latest turn's, else its last message of its own. */
  latestReply(threadId: string): Promise<string | null>;
  /**
   * The file `name` in the folder `root` on a machine, confined to that folder: a file that resolves
   * outside it (a symlink out) is refused, not read. Throws when the machine cannot be read.
   */
  readFile(hostId: string, root: string, name: string): Promise<FileRead>;
  /** firstmate-crew's board, or why it could not be read. */
  fleet(): Promise<FleetRead>;
}
