import { describe, expect, it } from "vitest";

import type { ThreadHistoryItem } from "./history";
import type { NamesPort } from "./ports";
import { withNames } from "./recent";
import { recordingLog } from "./testing/fixtures";

function item(threadId: string, n: number): ThreadHistoryItem {
  return {
    threadId,
    eventId: `${threadId}:idle:${n}`,
    reason: "finished",
    createdAt: new Date(Date.UTC(2026, 8, 15, 10, 0, n)).toISOString(),
    headline: "Finished",
    text: `Sentence ${n}.`,
  };
}

function notFound(): Error {
  return Object.assign(new Error("Thread not found"), { status: 404 });
}

describe("withNames", () => {
  it("names each sentence's thread and project, looking each thread up once", async () => {
    const lookups: string[] = [];
    const names: NamesPort = {
      async thread(threadId) {
        lookups.push(threadId);
        return { title: threadId === "t1" ? "Login fix" : null, projectId: "p1" };
      },
      projectName: async () => "Shop",
    };
    const items = await withNames([item("t1", 3), item("t2", 2), item("t1", 1)], names, recordingLog());
    expect(items.map(({ threadId, threadTitle, projectName, threadExists, text }) => ({ threadId, threadTitle, projectName, threadExists, text }))).toEqual([
      { threadId: "t1", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Sentence 3." },
      { threadId: "t2", threadTitle: null, projectName: "Shop", threadExists: true, text: "Sentence 2." },
      { threadId: "t1", threadTitle: "Login fix", projectName: "Shop", threadExists: true, text: "Sentence 1." },
    ]);
    expect(lookups).toEqual(["t1", "t2"]);
  });

  it("keeps a sentence whose thread is gone, or whose names bb cannot give, and says why in the log", async () => {
    const log = recordingLog();
    const names: NamesPort = {
      async thread(threadId) {
        if (threadId === "gone") return null;
        if (threadId === "down") throw new Error("bb away");
        return { title: "Login fix", projectId: "p1" };
      },
      projectName: async () => {
        throw notFound();
      },
    };
    const items = await withNames([item("gone", 3), item("down", 2), item("t1", 1)], names, log);
    expect(items.map(({ threadTitle, projectName, threadExists }) => ({ threadTitle, projectName, threadExists }))).toEqual([
      { threadTitle: null, projectName: null, threadExists: false },
      { threadTitle: null, projectName: null, threadExists: true },
      { threadTitle: "Login fix", projectName: null, threadExists: true },
    ]);
    expect(log.lines.some((line) => line.includes("bb away"))).toBe(true);
    expect(log.lines.some((line) => line.includes("project p1"))).toBe(true);
  });
});
