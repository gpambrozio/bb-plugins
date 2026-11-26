import { describe, expect, it } from "vitest";

import { AgentLinkSchema, PENDING_MS, createAgentLinks, type AgentLink } from "./agent-links";

function links(stored: AgentLink[] = []) {
  let clock = 1_000;
  let tokens = 0;
  const saved: AgentLink[][] = [];
  const store = createAgentLinks({
    load: async () => stored,
    save: async (list) => void saved.push(list),
    now: () => clock,
    newToken: () => `tok_${++tokens}`,
  });
  return { store, saved, advance: (ms: number) => (clock += ms) };
}

describe("agent links", () => {
  it("lets the thread bb is creating use the tab's tools, for a while, then only the thread it became", async () => {
    const { store, advance } = links();
    await store.load();
    const token = await store.begin("term_1");
    expect(store.mayUse("term_1", "thr_a")).toBe(true);
    expect(store.threadFor("term_1")).toBeNull();

    expect(await store.bind("term_1", token, "thr_a")).toBe(true);
    expect(store.mayUse("term_1", "thr_a")).toBe(true);
    expect(store.mayUse("term_1", "thr_fork")).toBe(false);
    expect(store.terminalFor("thr_a")).toBe("term_1");

    await store.begin("term_2");
    advance(PENDING_MS);
    expect(store.mayUse("term_2", "thr_b")).toBe(false);
  });

  it("keeps one thread per tab: a new one replaces the old, and dropping the tab forgets it", async () => {
    const { store, saved } = links([{ terminalId: "term_1", threadId: "thr_old", createdAt: 0, token: "" }]);
    await store.load();
    expect(store.threadFor("term_1")).toBe("thr_old");
    const token = await store.begin("term_1");
    await store.bind("term_1", token, "thr_new");
    expect(store.mayUse("term_1", "thr_old")).toBe(false);
    expect(store.threadFor("term_1")).toBe("thr_new");
    await store.drop("term_1");
    expect(store.threadFor("term_1")).toBeNull();
    expect(saved.at(-1)).toEqual([]);
  });

  it("applies changes in order, each on the one before", async () => {
    const { store } = links();
    await store.load();
    await Promise.all([store.begin("term_1"), store.begin("term_2"), store.bind("term_1", "tok_1", "thr_a"), store.drop("term_2")]);
    expect(store.all()).toEqual([{ terminalId: "term_1", threadId: "thr_a", createdAt: 1_000, token: "tok_1" }]);
  });

  it("binds a spawn only to the link it began: not after the link was dropped, nor over a newer one", async () => {
    const { store } = links();
    await store.load();
    // Two windows start a chat for the same tab; the newer spawn answers first.
    const older = await store.begin("term_1");
    const newer = await store.begin("term_1");
    expect(await store.bind("term_1", newer, "thr_newest")).toBe(true);
    expect(await store.bind("term_1", older, "thr_older")).toBe(false);
    expect(store.threadFor("term_1")).toBe("thr_newest");

    // Let go of while bb was still creating the thread: the answer binds nothing.
    const pending = await store.begin("term_2");
    await store.drop("term_2");
    expect(await store.bind("term_2", pending, "thr_forgotten")).toBe(false);
    expect(store.terminalFor("thr_forgotten")).toBeNull();
    expect(store.all().map((link) => link.terminalId)).toEqual(["term_1"]);
  });

  it("drops a failed spawn's link only when it is still the one that spawn began", async () => {
    const { store } = links();
    await store.load();
    const failed = await store.begin("term_1");
    const newer = await store.begin("term_1");
    await store.dropPending("term_1", failed);
    expect(store.tokenFor("term_1")).toBe(newer);
    await store.dropPending("term_1", newer);
    expect(store.all()).toEqual([]);
  });

  it("reads links stored before they had tokens", async () => {
    const { store } = links([{ terminalId: "term_1", threadId: "thr_old", createdAt: 0 } as AgentLink]);
    await store.load();
    expect(store.threadFor("term_1")).toBe("thr_old");
    expect(AgentLinkSchema.parse({ terminalId: "term_1", threadId: "thr_old", createdAt: 0 })).toMatchObject({ token: "" });
  });
});
