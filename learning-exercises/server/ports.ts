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
  /** The thread's last finished turn, from its event log. */
  lastTurn(threadId: string): Promise<{ turnId: string; status: string } | null>;
  /** The `fileChange` changes of one turn, with the paths as the provider reported them. */
  turnFileChanges(threadId: string, turnId: string): Promise<FileChange[]>;
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
