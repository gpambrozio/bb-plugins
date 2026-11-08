/**
 * An in-memory `Ports` for tests: threads, projects, HEADs, commits and pull requests set by the test,
 * and every fork, send and card recorded. Cards stay open until the test answers or cancels them.
 */
import type { PluginInteractionResult } from "@get-bb/plugin-sdk";

import {
  FileConflict,
  type CardRequest,
  type FileRead,
  type FileRoot,
  type ForkRequest,
  type MessageRead,
  type MessageWindow,
  type PluginThread,
  type Ports,
  type ProjectInfo,
  type PullRequestInfo,
  type SpawnRequest,
  type ThreadInfo,
} from "../ports";
import type { Commit, CommittedFile, FileChange } from "../signals";

export interface OpenCard {
  request: CardRequest;
  resolve(result: PluginInteractionResult): void;
}

export function thread(overrides: Partial<ThreadInfo> & { id: string }): ThreadInfo {
  return {
    projectId: "proj_1",
    providerId: "claude-code",
    environmentId: "env_1",
    title: "Add retries",
    status: "idle",
    parentThreadId: null,
    originPluginId: null,
    lifecycleOwnerThreadId: null,
    visibility: "visible",
    archivedAt: null,
    ...overrides,
  };
}

export class FakePorts implements Ports {
  clock = 1_000_000;
  threads = new Map<string, ThreadInfo>();
  projects = new Map<string, ProjectInfo>([["proj_1", { id: "proj_1", name: "calc", gitRemoteUrl: "git@github.com:acme/calc.git" }]]);
  paths = new Map<string, string>([["env_1", "/work/calc"]]);
  turns = new Map<string, { turnId: string; status: string }>();
  /** The turn running (or last run) per thread, as `currentTurn` reads it. */
  running = new Map<string, string>();
  fileChanges = new Map<string, FileChange[]>();
  pending = new Set<string>();
  /** The agent's messages per thread, with the time each completed. */
  messages = new Map<string, { at: number; text: string }[]>();
  /** `agentMessages` answers nothing, as when the event log cannot be read. */
  messagesUnreadable = false;
  heads = new Map<string, string>([["env_1", "aaa111"]]);
  commits = new Map<string, { commits: Commit[]; files: CommittedFile[] }>();
  branch = new Map<string, Commit[]>();
  pulls = new Map<string, PullRequestInfo>();
  forkable = new Set<string>(["claude-code", "codex"]);
  forkFails = false;
  /** Runs after bb made the fork but before `fork` answers: the fork's agent acting early, or a held fork. */
  duringFork: ((threadId: string) => Promise<void>) | null = null;
  /** `card` throws instead of opening. */
  cardThrows = false;
  metadata = new Map<string, string>();
  /** Other plugin metadata per thread: `${threadId}` to key to value (the session id stays in `metadata`). */
  threadMetadata = new Map<string, Record<string, string>>();
  spawned: SpawnRequest[] = [];
  spawnFails = false;
  /** Runs after bb made the thread but before `spawn` answers. */
  duringSpawn: ((threadId: string) => Promise<void>) | null = null;
  stopped: string[] = [];
  archived: string[] = [];
  archiveFails = false;
  /** Environment roots, by environment id. */
  roots = new Map<string, FileRoot>([["env_1", { hostId: "host_1", rootPath: "/work/calc" }]]);
  /** Project checkouts, `${projectId}:${hostId}`. */
  checkouts = new Map<string, string>([["proj_1:host_1", "/work/calc"]]);
  /** Files by `${rootPath}/${path}`. */
  files = new Map<string, string>();
  /** What `readFile` answers for a file instead of its text (`binary`, `too-large`, or null for a failed read). */
  fileReads = new Map<string, FileRead | null>();
  /** Every `readFile`, as `${rootPath}/${path}`, in order. */
  reads: string[] = [];
  /** Runs after `readFile` read a file and before it answers: the file changing under the reader. */
  afterRead: ((key: string) => void) | null = null;
  /** Every `writeFile`, in order. */
  writes: { root: FileRoot; path: string; content: string; expectedSha256: string | null }[] = [];
  /** `pluginThreadsWith` answers null, as when bb cannot list. */
  pluginThreadsUnreadable = false;
  private nextSpawn = 1;
  forks: ForkRequest[] = [];
  sends: { threadId: string; visible: string; agentOnly: string }[] = [];
  cards: OpenCard[] = [];
  unarchived: string[] = [];
  changes = 0;
  warnings: string[] = [];
  private nextFork = 1;

  now(): number {
    return this.clock;
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  async thread(threadId: string) {
    return this.threads.get(threadId) ?? null;
  }

  async project(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }

  async environmentPath(environmentId: string) {
    return this.paths.get(environmentId) ?? null;
  }

  async environmentRoot(environmentId: string) {
    return this.roots.get(environmentId) ?? null;
  }

  async projectCheckout(projectId: string, hostId: string) {
    return this.checkouts.get(`${projectId}:${hostId}`) ?? null;
  }

  /** The hash a file has in this fake: its text, so a test can predict it. */
  static sha(text: string): string {
    return `sha:${text}`;
  }

  async readFile(root: FileRoot, relativePath: string): Promise<FileRead | null> {
    const key = `${root.rootPath}/${relativePath}`;
    this.reads.push(key);
    const text = this.files.get(key);
    let read: FileRead | null;
    if (this.fileReads.has(key)) read = this.fileReads.get(key)!;
    else if (text === undefined) read = { kind: "missing" };
    else read = { kind: "text", text, sha256: FakePorts.sha(text), sizeBytes: Buffer.byteLength(text) };
    this.afterRead?.(key);
    return read;
  }

  async writeFile(root: FileRoot, relativePath: string, content: string, expectedSha256: string | null) {
    const key = `${root.rootPath}/${relativePath}`;
    const current = this.files.get(key);
    const currentSha = current === undefined ? null : FakePorts.sha(current);
    if (currentSha !== expectedSha256) throw new FileConflict(relativePath);
    this.writes.push({ root, path: relativePath, content, expectedSha256 });
    this.files.set(key, content);
  }

  async currentTurn(threadId: string) {
    return this.running.get(threadId) ?? null;
  }

  async lastTurn(threadId: string) {
    return this.turns.get(threadId) ?? null;
  }

  async turnFileChanges(threadId: string, turnId: string) {
    return this.fileChanges.get(`${threadId}:${turnId}`) ?? [];
  }

  /** The agent writes a message in a thread now. */
  say(threadId: string, text: string): void {
    this.messages.set(threadId, [...(this.messages.get(threadId) ?? []), { at: this.clock, text }]);
  }

  /** Every read always completes here; `replies.test.ts` pages the real reader over the SDK's fake host. */
  async agentMessages(threadId: string, { from, to }: MessageWindow): Promise<MessageRead | null> {
    if (this.messagesUnreadable) return null;
    const texts = (this.messages.get(threadId) ?? []).filter((message) => message.at >= from && (to === null || message.at < to)).map((message) => message.text);
    return { texts, complete: true, before: null, pages: 1 };
  }

  async interactionPending(threadId: string) {
    return this.pending.has(threadId);
  }

  async headSha(environmentId: string) {
    return this.heads.get(environmentId) ?? null;
  }

  async commitsSince(environmentId: string, sha: string) {
    return this.commits.get(`${environmentId}:${sha}`) ?? { commits: [], files: [] };
  }

  async branchCommits(environmentId: string) {
    return this.branch.get(environmentId) ?? [];
  }

  async pullRequest(environmentId: string) {
    return this.pulls.get(environmentId) ?? null;
  }

  async canFork(providerId: string) {
    return this.forkable.has(providerId);
  }

  async fork(request: ForkRequest) {
    if (this.forkFails) throw new Error("fork refused");
    this.forks.push(request);
    const id = `thr_fork${this.nextFork++}`;
    const source = this.threads.get(request.sourceThreadId)!;
    this.threads.set(id, { ...source, id, originPluginId: "learning-exercises", title: request.title });
    this.metadata.set(id, request.sessionId);
    if (this.duringFork !== null) await this.duringFork(id);
    return { threadId: id };
  }

  async send(threadId: string, visible: string, agentOnly: string) {
    this.sends.push({ threadId, visible, agentOnly });
  }

  async spawn(request: SpawnRequest) {
    if (this.spawnFails) throw new Error("spawn refused");
    this.spawned.push(request);
    const id = `thr_spawn${this.nextSpawn++}`;
    this.threads.set(id, thread({ id, projectId: request.projectId, providerId: request.providerId, environmentId: request.environmentId, title: request.title, originPluginId: "learning-exercises", visibility: request.hidden ? "hidden" : "visible" }));
    this.threadMetadata.set(id, request.metadata);
    if (this.duringSpawn !== null) await this.duringSpawn(id);
    return { threadId: id };
  }

  async stopThread(threadId: string) {
    this.stopped.push(threadId);
  }

  async archiveThread(threadId: string) {
    if (this.archiveFails) throw new Error("archive refused");
    this.archived.push(threadId);
    const current = this.threads.get(threadId);
    if (current !== undefined) this.threads.set(threadId, { ...current, archivedAt: this.clock });
  }

  async pluginThreadsWith(metadataKey: string): Promise<PluginThread[] | null> {
    if (this.pluginThreadsUnreadable) return null;
    const found: PluginThread[] = [];
    for (const [threadId, values] of this.threadMetadata) {
      const value = values[metadataKey];
      const row = this.threads.get(threadId);
      if (value === undefined || row === undefined || row.originPluginId !== "learning-exercises") continue;
      found.push({ threadId, value, archived: row.archivedAt !== null, status: row.status });
    }
    return found;
  }

  async metadataValue(threadId: string, key: string) {
    if (key === "session") return this.metadata.get(threadId) ?? null;
    return this.threadMetadata.get(threadId)?.[key] ?? null;
  }

  async sessionIdOf(threadId: string) {
    return this.metadata.get(threadId) ?? null;
  }

  async forkOf(sessionId: string, sourceThreadId: string) {
    for (const [threadId, session] of this.metadata) {
      if (session === sessionId && this.threads.get(threadId)?.id !== sourceThreadId) return threadId;
    }
    return null;
  }

  async unarchive(threadId: string) {
    this.unarchived.push(threadId);
    const current = this.threads.get(threadId);
    if (current !== undefined) this.threads.set(threadId, { ...current, archivedAt: null });
  }

  card(request: CardRequest): Promise<PluginInteractionResult> {
    if (this.cardThrows) return Promise.reject(new Error("requestInput refused"));
    return new Promise((resolve) => {
      const open: OpenCard = { request, resolve };
      this.cards.push(open);
      request.signal.addEventListener("abort", () => resolve({ outcome: "cancelled", reason: "request-aborted" }), { once: true });
    });
  }

  changed(): void {
    this.changes += 1;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** The newest card, answered with `value`. */
  answer(value: unknown): void {
    const card = this.cards.at(-1);
    if (card === undefined) throw new Error("no card is open");
    card.resolve({ outcome: "submitted", value: value as never });
  }

  cancel(reason: "timeout" | "user" | "plugin-disposed" | "thread-stopped" | "thread-deleted"): void {
    const card = this.cards.at(-1);
    if (card === undefined) throw new Error("no card is open");
    card.resolve({ outcome: "cancelled", reason });
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
