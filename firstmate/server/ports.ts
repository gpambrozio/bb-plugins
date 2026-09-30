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

/**
 * How a send meets a running turn. `auto` for the captain's words (joins the turn if the provider
 * can steer, queues otherwise), `steer` for the captain's note to a crewmate, `queue-if-active` for
 * watch output. None of them interrupts.
 */
export type SendMode = "auto" | "steer" | "queue-if-active";

/** Where a spawned thread works: a new worktree of its project, another thread's environment, or a plain directory. */
export type SpawnEnvironment = { kind: "worktree" } | { kind: "reuse"; environmentId: string } | { kind: "path"; path: string };

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
}

export interface ThreadsPort {
  /** Null when the thread is missing, deleted or archived. */
  get(id: string): Promise<ThreadInfo | null>;
  /** The thread's non-archived children. */
  children(parentId: string): Promise<ThreadInfo[]>;
  /** The thread's metadata in this plugin's namespace. */
  metadata(id: string): Promise<Record<string, unknown>>;
  /** How many interactions (questions, permissions, plans) wait on the thread. */
  pendingInteractions(id: string): Promise<number>;
  /** The thread's latest assistant text, or null when it has none. */
  lastText(id: string): Promise<string | null>;
  /** The directory the environment works in, when it is on the bb server's machine; null otherwise. */
  workspacePath(environmentId: string): Promise<string | null>;
  spawn(args: SpawnArgs): Promise<ThreadInfo>;
  send(id: string, text: string, mode: SendMode): Promise<"sent" | "queued">;
  stop(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  clearContext(id: string): Promise<void>;
  pin(id: string): Promise<void>;
}

export interface ProjectsPort {
  /** The project with a source at this directory on the bb server's machine, compared by real path. */
  findByPath(path: string): Promise<{ id: string } | null>;
  /** Registers the directory as a new project on the bb server's machine. */
  create(name: string, path: string): Promise<{ id: string }>;
  /** Every project's id and name, for resolving what the captain or the first mate typed. */
  list(): Promise<{ id: string; name: string }[]>;
}
