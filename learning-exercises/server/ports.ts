/**
 * Everything the offer engine and the sessions need from bb, as one interface. `bb-ports.ts` is the
 * real one; tests pass a fake. Keeping bb behind it keeps the policy and the state machine testable
 * without a bb.
 */
import type { PluginInteractionResult } from "@get-bb/plugin-sdk";

import type { CardPayload, SettledRow } from "../shared/types";
import type { GateThread } from "./policy";
import type { Commit, CommittedFile, FileChange } from "./signals";

export interface ThreadInfo extends GateThread {
  id: string;
  projectId: string;
  providerId: string;
  environmentId: string | null;
  title: string | null;
  status: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
}

export interface PullRequestInfo {
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
}

export interface ForkRequest {
  sourceThreadId: string;
  environmentId: string | null;
  sessionId: string;
  title: string;
  /** Agent-only: the session's brief. */
  brief: string;
  /** The one line the user sees as the fork's first message. */
  visible: string;
}

/** What `spawn` starts: a thread in an existing environment, with the plugin's metadata on it. */
export interface SpawnRequest {
  projectId: string;
  environmentId: string;
  providerId: string;
  title: string;
  hidden: boolean;
  /** The one line the user sees as the first message. */
  visible: string;
  /** Agent-only: the brief. */
  agentOnly: string;
  metadata: Record<string, string>;
}

/** A directory on a machine, the base files are read and written under. */
export interface FileRoot {
  hostId: string;
  rootPath: string;
}

/** What reading one file found: its text, or why there is none. */
export type FileRead =
  | { kind: "text"; text: string; sha256: string; sizeBytes: number }
  | { kind: "missing" }
  | { kind: "binary" }
  | { kind: "too-large" };

/** One of this plugin's threads that carries a metadata key. */
export interface PluginThread {
  threadId: string;
  value: string;
  archived: boolean;
  status: string;
}

/** `writeFile` found the file changed since the hash it was given (or present when it expected none). */
export class FileConflict extends Error {
  constructor(path: string) {
    super(`${path} changed since it was read.`);
    this.name = "FileConflict";
  }
}

export interface MessageWindow {
  from: number;
  to: number | null;
  /** Continue below this seq: every row at or above it was read already. Null starts at the newest. */
  before: string | null;
  /** The most pages to read. */
  pages: number;
}

/** What one read of the event log found. */
export interface MessageRead {
  /** The messages inside the window among the rows read, oldest first. */
  texts: string[];
  /** True when the read reached the window's start (or the log's); false when it stopped on its page budget. */
  complete: boolean;
  /** Where to continue an incomplete read; null when complete. */
  before: string | null;
  /** Pages read. */
  pages: number;
}

export interface CardRequest {
  threadId: string;
  payload: CardPayload;
  /** What the settled row keeps, given the submitted value. */
  describe(value: unknown): SettledRow;
  signal: AbortSignal;
}

export interface Ports {
  now(): number;
  thread(threadId: string): Promise<ThreadInfo | null>;
  project(projectId: string): Promise<ProjectInfo | null>;
  environmentPath(environmentId: string): Promise<string | null>;
  /** The machine and directory of an environment; null when it has no checkout (destroyed) or cannot be read. */
  environmentRoot(environmentId: string): Promise<FileRoot | null>;
  /** The project's checkout on a host, as an absolute path; null when it has none there or cannot be read. */
  projectCheckout(projectId: string, hostId: string): Promise<string | null>;
  /**
   * One file under a root, by a normalized relative path. Null when the read fails for a reason other
   * than the file being absent; `too-large` above `ORIENT_LIMITS.fileBytes`; `binary` for bytes that are
   * not UTF-8 or hold a NUL.
   */
  readFile(root: FileRoot, relativePath: string): Promise<FileRead | null>;
  /**
   * Writes UTF-8 text, creating parent folders. `expectedSha256` is the hash of the file as it was read,
   * or null to require that it does not exist. Throws `FileConflict` when it changed; anything else as is.
   */
  writeFile(root: FileRoot, relativePath: string, content: string, expectedSha256: string | null): Promise<void>;
  /** The id of the thread's newest turn, finished or running (its last `turn/started`); null when it cannot be read. */
  currentTurn(threadId: string): Promise<string | null>;
  /** The thread's last finished turn, from its event log. */
  lastTurn(threadId: string): Promise<{ turnId: string; status: string } | null>;
  /** The `fileChange` changes of one turn, with the paths as the provider reported them. */
  turnFileChanges(threadId: string, turnId: string): Promise<FileChange[]>;
  /**
   * The text of the agent's messages completed in the thread from `from` (inclusive) to `to` (exclusive,
   * null for now), oldest first, from its event log, reading newest first from `before` (a seq; null for
   * the newest) at most `pages` pages. Null when the log cannot be read.
   */
  agentMessages(threadId: string, window: MessageWindow): Promise<MessageRead | null>;
  interactionPending(threadId: string): Promise<boolean>;
  /** The workspace's HEAD, or null when the Git plugin cannot say (off, not a repository). */
  headSha(environmentId: string): Promise<string | null>;
  /** Commits since `sha` with the files they touched; null when the Git plugin cannot say. */
  commitsSince(environmentId: string, sha: string): Promise<{ commits: Commit[]; files: CommittedFile[] } | null>;
  /** The branch's commits ahead of its merge base, newest first; empty when the Git plugin cannot say. */
  branchCommits(environmentId: string): Promise<Commit[]>;
  pullRequest(environmentId: string): Promise<PullRequestInfo | null>;
  /** Whether the provider says it can fork a thread. */
  canFork(providerId: string): Promise<boolean>;
  fork(request: ForkRequest): Promise<{ threadId: string }>;
  /** Sends one visible line and an agent-only part; starts a turn, or joins the running one. */
  send(threadId: string, visible: string, agentOnly: string): Promise<void>;
  /** Starts a thread; throws when bb refuses. */
  spawn(request: SpawnRequest): Promise<{ threadId: string }>;
  /** Stops a thread's running turn; throws on failure. */
  stopThread(threadId: string): Promise<void>;
  /** Archives a thread; throws on failure. */
  archiveThread(threadId: string): Promise<void>;
  /** This plugin's (unarchived) threads whose metadata holds `metadataKey`; null when either read fails. */
  pluginThreadsWith(metadataKey: string): Promise<PluginThread[] | null>;
  /** One string value of a thread's plugin metadata; null when absent, not a string or unreadable. */
  metadataValue(threadId: string, key: string): Promise<string | null>;
  /** The session id seeded on a thread's metadata, for a fork bb answers before `fork` returns. */
  sessionIdOf(threadId: string): Promise<string | null>;
  /** The fork made for a session whose id never reached the store (a reload mid-fork); null when none. */
  forkOf(sessionId: string, sourceThreadId: string): Promise<string | null>;
  unarchive(threadId: string): Promise<void>;
  card(request: CardRequest): Promise<PluginInteractionResult>;
  /** Tells every open view that offers or sessions changed. */
  changed(): void;
  warn(message: string): void;
}
