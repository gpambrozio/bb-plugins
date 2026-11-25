import { describe, expect, it } from "vitest";

import { recentThreads, type RecentThreadSource } from "./recent";

const thread = (id: string, latestAttentionAt: number, change: Partial<RecentThreadSource> = {}): RecentThreadSource => ({
  id,
  displayTitle: `Thread ${id}`,
  isHidden: false,
  isArchived: false,
  isUnread: false,
  hasPendingInteraction: false,
  latestAttentionAt,
  ...change,
});

describe("recentThreads", () => {
  it("lists the threads that last wanted attention first, without the one on screen", () => {
    const threads = [thread("a", 1), thread("b", 3), thread("c", 2)];
    expect(recentThreads(threads, "b").map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("leaves out hidden helper threads and archived ones", () => {
    const threads = [thread("a", 1), thread("hidden", 5, { isHidden: true }), thread("old", 4, { isArchived: true })];
    expect(recentThreads(threads, null).map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps to the limit", () => {
    const threads = Array.from({ length: 9 }, (_, i) => thread(String(i), i));
    expect(recentThreads(threads, null, 5).map((t) => t.id)).toEqual(["8", "7", "6", "5", "4"]);
  });

  it("marks a thread that waits for an answer or has an unread reply", () => {
    const threads = [thread("asks", 3, { hasPendingInteraction: true }), thread("unread", 2, { isUnread: true }), thread("quiet", 1)];
    expect(recentThreads(threads, null).map((t) => t.needsAttention)).toEqual([true, true, false]);
  });

  it("does not reorder the list it was given", () => {
    const threads = [thread("a", 1), thread("b", 2)];
    recentThreads(threads, null);
    expect(threads.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
