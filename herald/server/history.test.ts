import { describe, expect, it } from "vitest";

import { HISTORY_HEADLINE_MAX, HISTORY_LIMIT, type HistoryItem } from "../shared/herald";
import { SentenceHistory, type HistoryKv } from "./history";
import { recordingLog } from "./testing/fixtures";

function fakeKv(): HistoryKv & { rows: Map<string, unknown>; failNext: boolean } {
  const rows = new Map<string, unknown>();
  const kv = {
    rows,
    failNext: false,
    async get<T>(key: string): Promise<T | undefined> {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (kv.failNext) {
        kv.failNext = false;
        throw new Error("disk full");
      }
      rows.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      return [...rows.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
  return kv;
}

function item(n: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    eventId: `t1:idle:${n}`,
    reason: "finished",
    createdAt: new Date(Date.UTC(2026, 8, 15, 10, 0, n)).toISOString(),
    headline: "Finished",
    text: `Sentence ${n}.`,
    ...overrides,
  };
}

describe("SentenceHistory", () => {
  it("keeps each thread's sentences newest first, and survives a reload through storage", async () => {
    const kv = fakeKv();
    const history = new SentenceHistory(kv, recordingLog());
    history.append("t1", item(1));
    history.append("t1", item(2));
    history.append("t2", item(1, { eventId: "t2:idle:1" }));
    await history.flush();
    expect((await history.list("t1")).map((entry) => entry.text)).toEqual(["Sentence 2.", "Sentence 1."]);
    const again = new SentenceHistory(kv, recordingLog());
    expect((await again.list("t1")).map((entry) => entry.eventId)).toEqual(["t1:idle:2", "t1:idle:1"]);
    expect(await again.list("t3")).toEqual([]);
  });

  it("replaces an item with the same event rather than adding a second", async () => {
    const history = new SentenceHistory(fakeKv(), recordingLog());
    history.append("t1", item(1, { text: "Plain." }));
    history.append("t1", item(1, { text: "Written by the model." }));
    await history.flush();
    expect((await history.list("t1")).map((entry) => entry.text)).toEqual(["Written by the model."]);
  });

  it("keeps only the newest items", async () => {
    const history = new SentenceHistory(fakeKv(), recordingLog());
    for (let n = 1; n <= HISTORY_LIMIT + 5; n += 1) history.append("t1", item(n));
    await history.flush();
    const items = await history.list("t1");
    expect(items).toHaveLength(HISTORY_LIMIT);
    expect(items[0]?.eventId).toBe(`t1:idle:${HISTORY_LIMIT + 5}`);
  });

  it("keeps a row under kv's limit by cutting a headline that runs to kilobytes", async () => {
    const kv = fakeKv();
    const history = new SentenceHistory(kv, recordingLog());
    for (let n = 1; n <= HISTORY_LIMIT; n += 1) history.append("t1", item(n, { headline: "x".repeat(14_000), reason: "error" }));
    await history.flush();
    const items = await history.list("t1");
    expect(items).toHaveLength(HISTORY_LIMIT);
    expect(items[0]?.headline.length).toBeLessThanOrEqual(HISTORY_HEADLINE_MAX + 1);
    expect(JSON.stringify(kv.rows.get("history:t1")).length).toBeLessThan(100_000);
  });

  it("forgets a thread, and reports a write that failed without throwing", async () => {
    const kv = fakeKv();
    const log = recordingLog();
    const history = new SentenceHistory(kv, log);
    history.append("t1", item(1));
    await history.flush();
    await history.remove("t1");
    expect(await history.list("t1")).toEqual([]);
    expect(kv.rows.size).toBe(0);
    kv.failNext = true;
    history.append("t1", item(2));
    await history.flush();
    expect(log.lines.some((line) => line.includes("disk full"))).toBe(true);
  });

  describe("recent", () => {
    function at(threadId: string, second: number): HistoryItem {
      return item(second, { eventId: `${threadId}:idle:${second}`, text: `${threadId} ${second}.` });
    }

    it("merges every thread's sentences newest first, cut to the limit", async () => {
      const kv = fakeKv();
      kv.rows.set("config", { other: "row" });
      const history = new SentenceHistory(kv, recordingLog());
      history.append("t1", at("t1", 1));
      history.append("t1", at("t1", 4));
      history.append("t2", at("t2", 2));
      history.append("t2", at("t2", 5));
      history.append("t3", at("t3", 3));
      await history.flush();
      expect((await history.recent(10)).map((entry) => entry.text)).toEqual(["t2 5.", "t1 4.", "t3 3.", "t2 2.", "t1 1."]);
      expect((await history.recent(2)).map((entry) => [entry.threadId, entry.eventId])).toEqual([
        ["t2", "t2:idle:5"],
        ["t1", "t1:idle:4"],
      ]);
    });

    it("includes a sentence whose write was only just issued", async () => {
      const history = new SentenceHistory(fakeKv(), recordingLog());
      history.append("t1", at("t1", 1));
      expect((await history.recent(5)).map((entry) => entry.text)).toEqual(["t1 1."]);
    });

    it("leaves out a deleted thread, and skips what it cannot read", async () => {
      const kv = fakeKv();
      const history = new SentenceHistory(kv, recordingLog());
      history.append("t1", at("t1", 1));
      history.append("t2", at("t2", 2));
      await history.remove("t2");
      kv.rows.set("history:t3", "not a list");
      kv.rows.set("history:t4", [{ eventId: "broken" }, at("t4", 3)]);
      expect((await history.recent(5)).map((entry) => entry.text)).toEqual(["t4 3.", "t1 1."]);
    });

    it("is empty when no thread has a sentence", async () => {
      expect(await new SentenceHistory(fakeKv(), recordingLog()).recent(20)).toEqual([]);
    });
  });
});
