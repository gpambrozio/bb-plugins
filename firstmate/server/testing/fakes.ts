/**
 * Plain in-memory stand-ins for the ports (`../ports.ts`) and the store, for tests. They record every
 * call so a test can assert what reached bb, and in what order.
 */
import { resolve } from "node:path";

import type { PluginKvStorage } from "@get-bb/plugin-sdk";

import type { ProjectsPort, SendMode, SpawnArgs, ThreadInfo, ThreadsPort } from "../ports";
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
  private readonly failures = new Map<ThreadMethod, Error>();
  private nextId = 1;
  private clock = 1_000;

  /** Adds a thread; everything not given gets a plain default. */
  add(fields: Partial<ThreadInfo> = {}): ThreadInfo {
    const thread: ThreadInfo = {
      id: fields.id ?? this.newId(),
      title: null,
      status: "idle",
      parentThreadId: null,
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

  setPendingInteractions(id: string, count: number): void {
    this.pending.set(id, count);
  }

  setStatus(id: string, status: ThreadInfo["status"]): void {
    this.update(id, { status });
  }

  /** Archives without recording a call, as the captain archiving it in bb would. */
  archiveNow(id: string): void {
    this.update(id, { archivedAt: this.clock++ });
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

  async get(id: string): Promise<ThreadInfo | null> {
    this.record("get", id);
    await tick();
    this.throwIfFailing("get");
    const thread = this.threads.get(id);
    return thread === undefined || thread.archivedAt !== null ? null : { ...thread };
  }

  async children(parentId: string): Promise<ThreadInfo[]> {
    this.record("children", parentId);
    await tick();
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

  async spawn(args: SpawnArgs): Promise<ThreadInfo> {
    this.record("spawn", args);
    await tick();
    this.throwIfFailing("spawn");
    this.spawned.push(args);
    const thread = this.add({
      title: args.title,
      status: "starting",
      parentThreadId: args.parentThreadId ?? null,
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

  async pin(id: string): Promise<void> {
    this.record("pin", id);
    await tick();
    this.throwIfFailing("pin");
    this.require(id);
  }

  private record(method: ThreadMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
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
