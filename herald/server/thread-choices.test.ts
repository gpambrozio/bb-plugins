import { describe, expect, it } from "vitest";

import type { ThreadChoice } from "../shared/thread-choice";
import type { ThreadChoicesPort } from "./ports";
import { ThreadChoices } from "./thread-choices";

/** A thread tree with Herald's metadata on some threads, counting the calls made to read it. */
function fakePort(parents: Record<string, string | null>, own: Record<string, ThreadChoice> = {}) {
  const stored = new Map(Object.entries(own));
  const calls = { ancestors: [] as string[][], ownChoices: [] as string[][] };
  const port: ThreadChoicesPort = {
    async ancestors(threadIds) {
      calls.ancestors.push([...threadIds]);
      return threadIds
        .filter((id) => id in parents)
        .map((threadId) => {
          const ancestorIds: string[] = [];
          for (let at = parents[threadId] ?? null; at !== null; at = parents[at] ?? null) ancestorIds.push(at);
          return { threadId, ancestorIds };
        });
    },
    async ownChoices(threadIds) {
      calls.ownChoices.push([...threadIds]);
      return new Map(threadIds.flatMap((id) => (stored.has(id) ? [[id, stored.get(id) as ThreadChoice] as const] : [])));
    },
    async setOwn(threadId, choice) {
      if (choice === null) stored.delete(threadId);
      else stored.set(threadId, choice);
    },
  };
  return { port, calls, stored };
}

describe("ThreadChoices", () => {
  it("reads every row's choice and its ancestors' in one call each, and leaves unknown threads out", async () => {
    const { port, calls } = fakePort({ coord: null, w1: "coord", w2: "coord", solo: null }, { coord: "silent", w2: "announce" });
    const inputs = await new ThreadChoices(port).inputs(["w1", "w2", "solo", "gone"]);
    expect(Object.fromEntries(inputs)).toEqual({
      w1: { own: null, inherited: { choice: "silent", threadId: "coord", fromParent: true } },
      w2: { own: "announce", inherited: { choice: "silent", threadId: "coord", fromParent: true } },
      solo: { own: null, inherited: null },
    });
    expect(calls.ancestors).toEqual([["w1", "w2", "solo", "gone"]]);
    expect(calls.ownChoices).toEqual([["w1", "coord", "w2", "solo"]]);
  });

  it("reads in batches bb accepts", async () => {
    const parents = Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`t${index}`, null]));
    const { port, calls } = fakePort(parents);
    const inputs = await new ThreadChoices(port).inputs(Object.keys(parents));
    expect(inputs.size).toBe(450);
    expect(calls.ancestors.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(calls.ownChoices.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it("stores a choice on the thread, and clears it for Default", async () => {
    const { port, stored } = fakePort({ coord: null, w1: "coord" }, { coord: "questions" });
    const choices = new ThreadChoices(port);
    await choices.set("w1", "silent");
    expect(stored.get("w1")).toBe("silent");
    expect(await choices.inputsOf("w1")).toEqual({
      own: "silent",
      inherited: { choice: "questions", threadId: "coord", fromParent: true },
    });
    await choices.set("w1", "default");
    expect(stored.has("w1")).toBe(false);
  });

  it("has no choice for a thread bb does not know", async () => {
    const { port } = fakePort({});
    expect(await new ThreadChoices(port).inputsOf("gone")).toEqual({ own: null, inherited: null });
  });
});
