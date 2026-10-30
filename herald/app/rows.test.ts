import { describe, expect, it } from "vitest";

import type { AttentionEntry } from "../shared/herald";
import { FRESH_ENTRY_MS, joinRows, type ThreadState } from "./rows";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

function entry(threadId: string, overrides: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    threadId,
    projectId: "p1",
    projectName: "Shop",
    threadTitle: "Stored title",
    lastRequest: null,
    folder: null,
    reason: "finished",
    eventId: `${threadId}:idle:1`,
    requestId: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    headline: "Finished",
    detail: null,
    summary: { status: "ready", text: "Done." },
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    id,
    projectId: "p1",
    displayTitle: `Thread ${id}`,
    status: "idle",
    isHidden: false,
    isArchived: false,
    isUnread: true,
    hasPendingInteraction: false,
    indicator: "unread-success",
    latestAttentionAt: NOW - 60_000,
    ...overrides,
  };
}

describe("joinRows", () => {
  it("joins Herald's entries with bb's flagged threads, newest first", () => {
    const rows = joinRows(
      [entry("t1")],
      [thread("t1"), thread("t2", { latestAttentionAt: NOW - 10_000, indicator: "unread-error" }), thread("t3", { isUnread: false })],
      NOW,
    );
    expect(rows.map((row) => [row.threadId, row.reason, row.entry === null])).toEqual([
      ["t2", "error", true],
      ["t1", "finished", false],
    ]);
    // bb's live title wins over the one stored with the entry.
    expect(rows[1]?.title).toBe("Thread t1");
  });

  it("shows a question while bb says the thread waits for input, and drops it once answered", () => {
    const question = entry("t1", { reason: "question", requestId: "i1" });
    expect(joinRows([question], [thread("t1", { status: "active", hasPendingInteraction: true })], NOW)).toHaveLength(1);
    expect(joinRows([question], [thread("t1", { status: "active", hasPendingInteraction: false })], NOW)).toEqual([]);
  });

  it("drops an entry once its thread has been read, unless it is fresh", () => {
    const read = thread("t1", { isUnread: false });
    expect(joinRows([entry("t1")], [read], NOW)).toEqual([]);
    expect(joinRows([entry("t1", { createdAt: new Date(NOW - FRESH_ENTRY_MS + 1000).toISOString() })], [read], NOW)).toHaveLength(1);
  });

  it("hides a finish whose thread is working again, and a flagged thread that is", () => {
    expect(joinRows([entry("t1")], [thread("t1", { status: "active" })], NOW)).toEqual([]);
    expect(joinRows([], [thread("t2", { status: "active" })], NOW)).toEqual([]);
    expect(joinRows([], [thread("t3", { status: "active", hasPendingInteraction: true })], NOW)[0]?.reason).toBe("input");
  });

  it("drops entries for threads bb no longer lists, archived ones, and hidden threads", () => {
    expect(joinRows([entry("gone")], [], NOW)).toEqual([]);
    expect(joinRows([entry("t1")], [thread("t1", { isArchived: true })], NOW)).toEqual([]);
    expect(joinRows([], [thread("h1", { isHidden: true })], NOW)).toEqual([]);
  });

  it("shows Herald's entries as they are while bb's list is loading", () => {
    const rows = joinRows([entry("t1")], null, NOW);
    expect(rows.map((row) => row.title)).toEqual(["Stored title"]);
  });
});

describe("joinRows with a finished turn the sentence tool kept quiet", () => {
  /** bb's attention time for the thread as the quiet turn ended. */
  const ATTENTION_AT = NOW - 60_000;
  const quiet = () => entry("t1", { createdAt: new Date(ATTENTION_AT + 2_000).toISOString(), summary: { status: "quiet", attentionAt: ATTENTION_AT } });

  it("lists neither the quiet entry nor bb's unread flag for that turn", () => {
    expect(joinRows([quiet()], [thread("t1", { latestAttentionAt: ATTENTION_AT })], NOW)).toEqual([]);
    expect(joinRows([quiet()], [thread("t1", { latestAttentionAt: ATTENTION_AT - 100 })], NOW)).toEqual([]);
    expect(joinRows([quiet()], null, NOW)).toEqual([]);
  });

  it("still lists what bb says waits on the user, an error, or any later flag", () => {
    const reasons = (threads: ThreadState[]) => joinRows([quiet()], threads, NOW).map((row) => row.reason);
    expect(reasons([thread("t1", { latestAttentionAt: ATTENTION_AT, hasPendingInteraction: true, indicator: "waiting-for-input" })])).toEqual(["input"]);
    expect(reasons([thread("t1", { latestAttentionAt: ATTENTION_AT, indicator: "unread-error" })])).toEqual(["error"]);
    // A turn Herald missed (it was off) a second later is listed, then and an hour on.
    expect(reasons([thread("t1", { latestAttentionAt: ATTENTION_AT + 1_000 })])).toEqual(["finished"]);
    expect(joinRows([quiet()], [thread("t1", { latestAttentionAt: ATTENTION_AT + 1 })], NOW + 3_600_000).map((row) => row.reason)).toEqual(["finished"]);
  });

  it("leaves other threads' unread flags alone", () => {
    expect(joinRows([quiet()], [thread("t1", { latestAttentionAt: ATTENTION_AT }), thread("t2")], NOW).map((row) => row.threadId)).toEqual(["t2"]);
  });
});
