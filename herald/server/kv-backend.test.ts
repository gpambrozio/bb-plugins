import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import { ENTRY_PREFIX, kvBackend } from "./kv-backend";

class FakeKv implements PluginKvStorage {
  readonly rows = new Map<string, unknown>();
  readonly sets: string[] = [];
  readonly deletes: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.rows.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.sets.push(key);
    this.rows.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.rows.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.rows.keys()].filter((key) => key.startsWith(prefix));
  }
}

function entry(threadId: string, headline = "Finished"): AttentionEntry {
  return {
    threadId,
    projectId: "p1",
    projectName: null,
    threadTitle: null,
    lastRequest: null,
    folder: null,
    reason: "finished",
    eventId: `${threadId}:idle:1`,
    requestId: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    headline,
    detail: null,
    summary: { status: "ready", text: headline },
  };
}

describe("kvBackend", () => {
  it("keeps one row per thread and reads only its own rows", async () => {
    const kv = new FakeKv();
    kv.rows.set("config", { unrelated: true });
    const backend = kvBackend(kv);
    await backend.write([entry("t1"), entry("t2")]);
    expect([...kv.rows.keys()].sort()).toEqual(["config", `${ENTRY_PREFIX}t1`, `${ENTRY_PREFIX}t2`]);
    expect(await kvBackend(kv).read()).toHaveLength(2);
  });

  it("rewrites only the rows that changed, and deletes the rows of threads that left", async () => {
    const kv = new FakeKv();
    const backend = kvBackend(kv);
    await backend.write([entry("t1"), entry("t2")]);
    kv.sets.length = 0;
    await backend.write([entry("t1"), entry("t2", "Changed")]);
    expect(kv.sets).toEqual([`${ENTRY_PREFIX}t2`]);
    await backend.write([entry("t2", "Changed")]);
    expect(kv.deletes).toEqual([`${ENTRY_PREFIX}t1`]);
  });

  it("deletes rows it only read, once they leave the map", async () => {
    const kv = new FakeKv();
    await kvBackend(kv).write([entry("t1"), entry("t2")]);
    const reopened = kvBackend(kv);
    await reopened.read();
    await reopened.write([entry("t2")]);
    expect([...kv.rows.keys()]).toEqual([`${ENTRY_PREFIX}t2`]);
  });
});
