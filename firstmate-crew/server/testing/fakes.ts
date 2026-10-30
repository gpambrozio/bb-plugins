/**
 * Plain in-memory stand-ins for the ports (`../ports.ts`) and the store, for tests. They record every
 * call so a test can assert what reached bb, and in what order.
 */
import { resolve } from "node:path";

import type { PluginKvStorage } from "@get-bb/plugin-sdk";

import type { Log } from "../log";
import type {
  ContextUsage,
  NotificationLevel,
  NotificationsPort,
  ProjectsPort,
  RestState,
  SendMode,
  ShortenedMessage,
  SpawnArgs,
  ThreadInfo,
  ThreadAttention,
  ThreadOrigin,
  ThreadsPort,
  TurnEnd,
} from "../ports";
import { createStore, type Store } from "../store";

type ThreadMethod = keyof ThreadsPort;

/** Resolves on a later turn of the event loop, so fake calls interleave the way real ones would. */
function tick(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

export class FakeThreads implements ThreadsPort {
  readonly threads = new Map<string, ThreadInfo>();
  /** Every port call, in order. */
  readonly calls: { method: ThreadMethod; args: unknown[] }[] = [];
  readonly spawned: SpawnArgs[] = [];
  readonly sent: { id: string; text: string; mode: SendMode }[] = [];
  private readonly metadataById = new Map<string, Record<string, unknown>>();
  private readonly texts = new Map<string, string>();
  private readonly pending = new Map<string, number>();
  private readonly workspaces = new Map<string, string>();
  private readonly origins = new Map<string, ThreadOrigin>();
  private readonly failures = new Map<ThreadMethod, Error>();
  /** Calls held open until a test releases them, by method. */
  private readonly holds = new Map<ThreadMethod, Promise<void>>();
  /** Each thread's turn events, in the order bb would number them. */
  private readonly turnEvents = new Map<string, { type: "started" | "completed"; seq: number; at: number }[]>();
  private readonly usages = new Map<string, ContextUsage>();
  /** What `restState` adds to a thread's status; absent fields are at rest. */
  private readonly rest = new Map<string, Partial<Omit<RestState, "status" | "parentThreadId">>>();
  private nextSeq = 1;
  private nextId = 1;
  private clock = 1_000;

  /** Adds a thread; everything not given gets a plain default. */
  add(fields: Partial<ThreadInfo> = {}): ThreadInfo {
    const thread: ThreadInfo = {
      id: fields.id ?? this.newId(),
      title: null,
      status: "idle",
      parentThreadId: null,
      parentNotifications: "auto",
      projectId: "prj_default",
      environmentId: null,
      updatedAt: this.clock++,
      archivedAt: null,
      ...fields,
    };
    this.threads.set(thread.id, thread);
    return { ...thread };
  }

  setMetadata(id: string, metadata: Record<string, unknown>): void {
    this.metadataById.set(id, { ...metadata });
  }

  setText(id: string, text: string | null): void {
    if (text === null) this.texts.delete(id);
    else this.texts.set(id, text);
  }

  /** Where an environment works; one never set answers null, as one on another machine does. */
  setWorkspace(environmentId: string, path: string): void {
    this.workspaces.set(environmentId, path);
  }

  /** A thread's project and branch. A thread never given one answers null, as a thread bb does not have would. */
  setOrigin(id: string, origin: ThreadOrigin): void {
    this.origins.set(id, { ...origin });
  }

  setPendingInteractions(id: string, count: number): void {
    this.pending.set(id, count);
  }

  setStatus(id: string, status: ThreadInfo["status"]): void {
    this.update(id, { status });
  }

  /** Changes a thread's fields as bb would after some event, without a port call. */
  set(id: string, fields: Partial<ThreadInfo>): void {
    this.update(id, fields);
  }

  /** Appends a whole turn to the thread's event log: it started and ended at `endedAt`. */
  runTurn(id: string, endedAt: number): TurnEnd {
    const events = this.turnEvents.get(id) ?? [];
    events.push({ type: "started", seq: this.nextSeq++, at: endedAt });
    const end = { type: "completed" as const, seq: this.nextSeq++, at: endedAt };
    events.push(end);
    this.turnEvents.set(id, events);
    return { seq: end.seq, at: end.at };
  }

  /** Sets what keeps a thread awake beyond its status: a queue, an interaction, background agents, its machine. */
  setRest(id: string, fields: Partial<Omit<RestState, "status" | "parentThreadId">>): void {
    this.rest.set(id, { ...this.rest.get(id), ...fields });
  }

  setUsage(id: string, usage: ContextUsage | null): void {
    if (usage === null) this.usages.delete(id);
    else this.usages.set(id, { ...usage });
  }

  /** Archives without recording a call, as the captain archiving it in bb would. */
  archiveNow(id: string): void {
    this.update(id, { archivedAt: this.clock++ });
  }

  /**
   * Holds the next call to `method` open until the returned function is called, so a test can act while
   * it is in flight.
   */
  hold(method: ThreadMethod): () => void {
    let release!: () => void;
    this.holds.set(method, new Promise<void>((resolve) => (release = resolve)));
    return () => release();
  }

  /** The next call to `method` rejects with this error; the one after works again. */
  failNext(method: ThreadMethod, error: Error): void {
    this.failures.set(method, error);
  }

  /** The next spawn rejects with this error. */
  failSpawn(error: Error): void {
    this.failNext("spawn", error);
  }

  /** The arguments of every call to one method, in order. */
  callsTo(method: ThreadMethod): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  async get(id: string, signal?: AbortSignal): Promise<ThreadInfo | null> {
    this.record("get", id);
    await this.settle("get", signal);
    this.throwIfFailing("get");
    const thread = this.threads.get(id);
    return thread === undefined || thread.archivedAt !== null ? null : { ...thread };
  }

  async children(parentId: string, signal?: AbortSignal): Promise<ThreadInfo[]> {
    this.record("children", parentId);
    await this.settle("children", signal);
    this.throwIfFailing("children");
    return [...this.threads.values()]
      .filter((thread) => thread.parentThreadId === parentId && thread.archivedAt === null)
      .map((thread) => ({ ...thread }));
  }

  async metadata(id: string): Promise<Record<string, unknown>> {
    this.record("metadata", id);
    await tick();
    this.throwIfFailing("metadata");
    return { ...(this.metadataById.get(id) ?? {}) };
  }

  async metadataOf(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    this.record("metadataOf", [...ids]);
    await tick();
    this.throwIfFailing("metadataOf");
    const found = new Map<string, Record<string, unknown>>();
    for (const id of ids) {
      const metadata = this.metadataById.get(id);
      if (metadata !== undefined) found.set(id, { ...metadata });
    }
    return found;
  }

  async pendingInteractions(id: string): Promise<number> {
    this.record("pendingInteractions", id);
    await tick();
    this.throwIfFailing("pendingInteractions");
    return this.pending.get(id) ?? 0;
  }

  async lastText(id: string): Promise<string | null> {
    this.record("lastText", id);
    await tick();
    this.throwIfFailing("lastText");
    return this.texts.get(id) ?? null;
  }

  async workspacePath(environmentId: string): Promise<string | null> {
    this.record("workspacePath", environmentId);
    await tick();
    this.throwIfFailing("workspacePath");
    return this.workspaces.get(environmentId) ?? null;
  }

  async origin(id: string): Promise<ThreadOrigin | null> {
    this.record("origin", id);
    await tick();
    this.throwIfFailing("origin");
    const origin = this.origins.get(id);
    return origin === undefined ? null : { ...origin };
  }

  async spawn(args: SpawnArgs): Promise<ThreadInfo> {
    this.record("spawn", args);
    await tick();
    this.throwIfFailing("spawn");
    this.spawned.push(args);
    const thread = this.add({
      title: args.title,
      status: "starting",
      parentThreadId: args.parentThreadId ?? null,
      // bb's own default when a spawn names none.
      parentNotifications: args.parentNotifications ?? "auto",
      projectId: args.projectId,
      environmentId: args.environment.kind === "reuse" ? args.environment.environmentId : `env_${this.nextId}`,
    });
    this.metadataById.set(thread.id, { ...args.metadata });
    return thread;
  }

  async send(id: string, text: string, mode: SendMode): Promise<"sent" | "queued"> {
    this.record("send", id, text, mode);
    await tick();
    this.throwIfFailing("send");
    const thread = this.require(id);
    this.sent.push({ id, text, mode });
    return mode === "queue-if-active" && thread.status !== "idle" ? "queued" : "sent";
  }

  async sendShortened(id: string, message: ShortenedMessage, mode: SendMode): Promise<"sent" | "queued"> {
    this.record("sendShortened", id, message, mode);
    await tick();
    this.throwIfFailing("sendShortened");
    const thread = this.require(id);
    this.sent.push({ id, text: message.hidden, mode });
    return mode === "queue-if-active" && thread.status !== "idle" ? "queued" : "sent";
  }

  async stop(id: string): Promise<void> {
    this.record("stop", id);
    await tick();
    this.throwIfFailing("stop");
    this.require(id);
    this.update(id, { status: "idle" });
  }

  async archive(id: string): Promise<void> {
    this.record("archive", id);
    await tick();
    this.throwIfFailing("archive");
    this.require(id);
    this.update(id, { archivedAt: this.clock++ });
  }

  async clearContext(id: string): Promise<void> {
    this.record("clearContext", id);
    await tick();
    this.throwIfFailing("clearContext");
    this.require(id);
  }

  async compact(id: string): Promise<void> {
    this.record("compact", id);
    await tick();
    this.throwIfFailing("compact");
    this.require(id);
  }

  async restState(id: string, signal?: AbortSignal): Promise<RestState | null> {
    this.record("restState", id);
    await this.settle("restState", signal);
    this.throwIfFailing("restState");
    const thread = this.threads.get(id);
    if (thread === undefined || thread.archivedAt !== null) return null;
    const rest = this.rest.get(id) ?? {};
    return {
      status: thread.status,
      parentThreadId: thread.parentThreadId,
      runtimeStatus: rest.runtimeStatus ?? thread.status,
      queuedMessages: rest.queuedMessages ?? 0,
      pendingInteractions: rest.pendingInteractions ?? this.pending.get(id) ?? 0,
      backgroundAgents: rest.backgroundAgents ?? 0,
    };
  }

  async lastTurnEnd(id: string, signal?: AbortSignal): Promise<TurnEnd | null> {
    this.record("lastTurnEnd", id);
    await this.settle("lastTurnEnd", signal);
    this.throwIfFailing("lastTurnEnd");
    const ends = (this.turnEvents.get(id) ?? []).filter((event) => event.type === "completed");
    const last = ends.at(-1);
    return last === undefined ? null : { seq: last.seq, at: last.at };
  }

  async turnsStartedAfter(id: string, afterSeq: number, limit: number, signal?: AbortSignal): Promise<number> {
    this.record("turnsStartedAfter", id, afterSeq, limit);
    await this.settle("turnsStartedAfter", signal);
    this.throwIfFailing("turnsStartedAfter");
    const started = (this.turnEvents.get(id) ?? []).filter((event) => event.type === "started" && event.seq > afterSeq);
    return Math.min(started.length, limit);
  }

  async contextUsage(id: string, signal?: AbortSignal): Promise<ContextUsage | null> {
    this.record("contextUsage", id);
    await this.settle("contextUsage", signal);
    this.throwIfFailing("contextUsage");
    const usage = this.usages.get(id);
    return usage === undefined ? null : { ...usage };
  }

  private record(method: ThreadMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** A later turn of the event loop, after any hold on the method; rejects as bb's client does once aborted. */
  private async settle(method: ThreadMethod, signal: AbortSignal | undefined): Promise<void> {
    await tick();
    const held = this.holds.get(method);
    if (held !== undefined) {
      this.holds.delete(method);
      await held;
    }
    signal?.throwIfAborted();
  }

  private throwIfFailing(method: ThreadMethod): void {
    const error = this.failures.get(method);
    if (error === undefined) return;
    this.failures.delete(method);
    throw error;
  }

  private require(id: string): ThreadInfo {
    const thread = this.threads.get(id);
    if (thread === undefined) throw new Error(`HTTP 404: thread ${id} not found`);
    return thread;
  }

  private update(id: string, fields: Partial<ThreadInfo>): void {
    const thread = this.require(id);
    this.threads.set(id, { ...thread, ...fields, updatedAt: this.clock++ });
  }

  private newId(): string {
    return `thr_${this.nextId++}`;
  }
}

export function fakeThreads(): FakeThreads {
  return new FakeThreads();
}

export class FakeProjects implements ProjectsPort {
  readonly projects: { id: string; name: string; path: string }[];
  /** The projects `create` registered, in order. */
  readonly created: { id: string; name: string; path: string }[] = [];
  private nextId = 1;

  constructor(existing: { id: string; path: string; name?: string }[] = []) {
    this.projects = existing.map((project) => ({ name: project.name ?? project.id, ...project }));
  }

  async findByPath(path: string): Promise<{ id: string } | null> {
    await tick();
    const project = this.projects.find((candidate) => resolve(candidate.path) === resolve(path));
    return project === undefined ? null : { id: project.id };
  }

  async create(name: string, path: string): Promise<{ id: string }> {
    await tick();
    const project = { id: `prj_${this.nextId++}`, name, path };
    this.projects.push(project);
    this.created.push(project);
    return { id: project.id };
  }

  async list(): Promise<{ id: string; name: string }[]> {
    await tick();
    return this.projects.map(({ id, name }) => ({ id, name }));
  }
}

export function fakeProjects(existing: { id: string; path: string; name?: string }[] = []): FakeProjects {
  return new FakeProjects(existing);
}

type NotificationMethod = keyof NotificationsPort;

/** bb's push-notifications plugin: per-thread levels, read state and the notifications sent, in memory. */
export class FakeNotifications implements NotificationsPort {
  /** Whether the plugin offers `notifications.send`. */
  available = true;
  readonly levels = new Map<string, NotificationLevel>();
  readonly attentions = new Map<string, ThreadAttention>();
  readonly sent: { title: string; body: string; threadId: string }[] = [];
  /** Every `setOwnLevel`, in order. */
  readonly levelChanges: { threadId: string; level: NotificationLevel }[] = [];
  private readonly failures = new Map<NotificationMethod, Error>();

  /** Every call to `method` rejects with this error until `recover`. */
  fail(method: NotificationMethod, error: Error): void {
    this.failures.set(method, error);
  }

  recover(method: NotificationMethod): void {
    this.failures.delete(method);
  }

  async canSend(): Promise<boolean> {
    await tick();
    this.throwIfFailing("canSend");
    return this.available;
  }

  async ownLevel(threadId: string): Promise<NotificationLevel> {
    await tick();
    this.throwIfFailing("ownLevel");
    return this.levels.get(threadId) ?? "inherit";
  }

  async setOwnLevel(threadId: string, level: NotificationLevel): Promise<void> {
    await tick();
    this.throwIfFailing("setOwnLevel");
    this.levelChanges.push({ threadId, level });
    if (level === "inherit") this.levels.delete(threadId);
    else this.levels.set(threadId, level);
  }

  async send(notification: { title: string; body: string; threadId: string }): Promise<string[]> {
    await tick();
    this.throwIfFailing("send");
    this.sent.push({ ...notification });
    return ["desktop"];
  }

  async attention(threadId: string): Promise<ThreadAttention | null> {
    await tick();
    this.throwIfFailing("attention");
    return this.attentions.get(threadId) ?? { lastReadAt: null, latestAttentionAt: 0 };
  }

  private throwIfFailing(method: NotificationMethod): void {
    const error = this.failures.get(method);
    if (error !== undefined) throw error;
  }
}

/** `PluginKvStorage` over a Map, with values copied through JSON as bb's would be. */
export function memoryKv(): PluginKvStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get<T>(key: string): Promise<T | undefined> {
      const value = entries.get(key);
      return value === undefined ? undefined : (JSON.parse(value) as T);
    },
    async set(key, value) {
      entries.set(key, JSON.stringify(value));
    },
    async delete(key) {
      entries.delete(key);
    },
    async list(prefix = "") {
      return [...entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

/** The real store over an in-memory kv. */
export function memoryStore(): Store {
  return createStore(memoryKv());
}

/** A `Log` that keeps every message, so a test can assert what was logged and with what context. */
export interface FakeLog extends Log {
  readonly infos: string[];
  readonly warnings: string[];
  readonly errors: string[];
}

export function fakeLog(): FakeLog {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warnings,
    errors,
    info(message) {
      infos.push(message);
    },
    warn(message) {
      warnings.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
}
