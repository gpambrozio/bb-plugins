/**
 * The narrow slices of bb the server needs, so the first mate's lifecycle, the fleet and the crew
 * actions can be tested against plain in-memory fakes (`testing/fakes.ts`). `bb-ports.ts` implements
 * them over `bb.sdk`; nothing else in `server/` touches the SDK's thread or project areas.
 */
import type { ThreadStatus } from "../shared/types";

/** What the plugin reads of one bb thread. Times are epoch milliseconds. */
export interface ThreadInfo {
  id: string;
  title: string | null;
  status: ThreadStatus;
  parentThreadId: string | null;
  projectId: string;
  environmentId: string | null;
  updatedAt: number;
  archivedAt: number | null;
}

/** What says whether a thread is truly at rest, beyond its status: everything that would wake it. */
export interface RestState {
  status: ThreadStatus;
  /**
   * `status` refined by bb with the machine's state: "waiting-for-host" or "provisioning" while the
   * thread's machine is not ready. Anything but "idle" is not at rest.
   */
  runtimeStatus: string;
  /** Messages queued for the thread, waiting to be sent. */
  queuedMessages: number;
  /** Permissions, questions and plans waiting on someone. */
  pendingInteractions: number;
  /** Background agents the thread started that are still running, though its turn has ended. */
  backgroundAgents: number;
}

/** Where a thread's event log stands at the end of a turn. `at` is epoch milliseconds. */
export interface TurnEnd {
  seq: number;
  at: number;
}

/** How much of its context window a thread's conversation fills, as bb last measured it. */
export interface ContextUsage {
  usedTokens: number;
  /** bb marks the figure as an estimate rather than the provider's own count. */
  estimated: boolean;
}

/** Where a thread's work is, for telling the first mate which thread a request comes from. */
export interface ThreadOrigin {
  /** Null when bb no longer has the project. */
  projectName: string | null;
  /** Null when the thread has no environment, or its environment no branch. */
  branchName: string | null;
}

/**
 * How a send meets a running turn. `auto` for the captain's words (joins the turn if the provider
 * can steer, queues otherwise), `steer` for the captain's note to a crewmate, `queue-if-active` for
 * watch output. None of them interrupts.
 */
export type SendMode = "auto" | "steer" | "queue-if-active";

/** Where a spawned thread works: a new worktree of its project, another thread's environment, or a plain directory. */
export type SpawnEnvironment = { kind: "worktree" } | { kind: "reuse"; environmentId: string } | { kind: "path"; path: string };

/**
 * A message the captain sees as one line, `shown`, ending in a chip that opens `file` — a path inside the
 * thread's workspace — while the agent reads `hidden` as well.
 */
export interface ShortenedMessage {
  shown: string;
  file: { path: string; label: string };
  hidden: string;
}

export interface SpawnArgs {
  projectId: string;
  title: string;
  prompt: string;
  parentThreadId?: string;
  environment: SpawnEnvironment;
  /** Empty or absent leaves bb's default. */
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  /** Seeded into the plugin's own metadata namespace on the thread. */
  metadata: Record<string, string>;
  /** Created already pinned in the sidebar, in the same request (bb 0.45+). */
  pinned?: boolean;
}

export interface ThreadsPort {
  /** Null when the thread is missing, deleted or archived. */
  get(id: string): Promise<ThreadInfo | null>;
  /** The thread's non-archived children. */
  children(parentId: string): Promise<ThreadInfo[]>;
  /** The thread's metadata in this plugin's namespace. */
  metadata(id: string): Promise<Record<string, unknown>>;
  /**
   * The metadata of many threads in this plugin's namespace, read in as few requests as bb allows. A
   * thread with none is left out of the map.
   */
  metadataOf(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
  /** How many interactions (questions, permissions, plans) wait on the thread. */
  pendingInteractions(id: string): Promise<number>;
  /** The thread's latest assistant text, or null when it has none. */
  lastText(id: string): Promise<string | null>;
  /** The directory the environment works in, when it is on the bb server's machine; null otherwise. */
  workspacePath(environmentId: string): Promise<string | null>;
  /** The thread's project and branch, archived or not; null when bb has no such thread. */
  origin(id: string): Promise<ThreadOrigin | null>;
  spawn(args: SpawnArgs): Promise<ThreadInfo>;
  send(id: string, text: string, mode: SendMode): Promise<"sent" | "queued">;
  sendShortened(id: string, message: ShortenedMessage, mode: SendMode): Promise<"sent" | "queued">;
  stop(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  clearContext(id: string): Promise<void>;
  /** Asks bb for the same structured `/compact` turn its composer sends. */
  compact(id: string): Promise<void>;
  /** Null when the thread is missing, deleted or archived. */
  restState(id: string): Promise<RestState | null>;
  /** The thread's latest `turn/completed` event, or null when no turn has ended yet. */
  lastTurnEnd(id: string): Promise<TurnEnd | null>;
  /** How many turns have started since the event `afterSeq`, counting no further than `limit`. */
  turnsStartedAfter(id: string, afterSeq: number, limit: number): Promise<number>;
  /** The thread's context usage, or null when bb has no figure for it. */
  contextUsage(id: string): Promise<ContextUsage | null>;
}

export interface ProjectsPort {
  /** The project with a source at this directory on the bb server's machine, compared by real path. */
  findByPath(path: string): Promise<{ id: string } | null>;
  /** Registers the directory as a new project on the bb server's machine. */
  create(name: string, path: string): Promise<{ id: string }>;
  /** Every project's id and name, for resolving what the captain or the first mate typed. */
  list(): Promise<{ id: string; name: string }[]>;
}
