import { describe, expect, it } from "vitest";

import { setAllChats, settleChats, type ChatVisibilityPorts } from "./chat-visibility";

function fake(threads: { id: string; visibility: string }[], failing: string[] = []) {
  const updates: [string, string][] = [];
  const warnings: string[] = [];
  const ports: ChatVisibilityPorts = {
    list: async (offset, limit) => threads.slice(offset, offset + limit),
    update: async (threadId, visibility) => {
      if (failing.includes(threadId)) throw new Error("gone");
      updates.push([threadId, visibility]);
      const thread = threads.find((entry) => entry.id === threadId);
      if (thread !== undefined) thread.visibility = visibility;
    },
    warn: (text) => void warnings.push(text),
  };
  return { ports, updates, warnings, threads };
}

describe("setAllChats", () => {
  it("changes only the chats that differ, across pages, and skips one that fails", async () => {
    const threads = Array.from({ length: 150 }, (_, index) => ({ id: `thr_${index}`, visibility: index % 50 === 0 ? "visible" : "hidden" }));
    const { ports, updates, warnings } = fake(threads, ["thr_50"]);
    expect(await setAllChats(ports, "hidden")).toBe(2);
    expect(updates).toEqual([
      ["thr_0", "hidden"],
      ["thr_100", "hidden"],
    ]);
    expect(warnings).toEqual(["could not make agent chat thr_50 hidden: gone"]);
  });
});

describe("settleChats", () => {
  it("hides the chats that existed before, once, and leaves a chat opened since alone", async () => {
    const { ports, updates, threads } = fake([
      { id: "thr_old", visibility: "visible" },
      { id: "thr_new", visibility: "hidden" },
    ]);
    let migrated = false;
    const options = { alwaysShow: false, migrated: async () => migrated, markMigrated: async () => void (migrated = true) };
    await settleChats(ports, options);
    expect(updates).toEqual([["thr_old", "hidden"]]);
    expect(migrated).toBe(true);

    threads[1]!.visibility = "visible";
    await settleChats(ports, options);
    expect(updates).toHaveLength(1);
  });

  it("shows every chat when the owner always shows them", async () => {
    const { ports, updates } = fake([
      { id: "thr_a", visibility: "hidden" },
      { id: "thr_b", visibility: "visible" },
    ]);
    await settleChats(ports, { alwaysShow: true, migrated: async () => false, markMigrated: async () => undefined });
    expect(updates).toEqual([["thr_a", "visible"]]);
  });
});
