import { describe, expect, it } from "vitest";

import { PENDING_MS, createAgentLinks, type AgentLink } from "./agent-links";

function links(stored: AgentLink[] = []) {
  let clock = 1_000;
  const saved: AgentLink[][] = [];
  const store = createAgentLinks({
    load: async () => stored,
    save: async (list) => void saved.push(list),
    now: () => clock,
  });
  return { store, saved, advance: (ms: number) => (clock += ms) };
}

describe("agent links", () => {
  it("lets the thread bb is creating use the tab's tools, for a while, then only the thread it became", async () => {
    const { store, advance } = links();
    await store.load();
    await store.begin("term_1");
    expect(store.mayUse("term_1", "thr_a")).toBe(true);
    expect(store.threadFor("term_1")).toBeNull();

    await store.bind("term_1", "thr_a");
    expect(store.mayUse("term_1", "thr_a")).toBe(true);
    expect(store.mayUse("term_1", "thr_fork")).toBe(false);
    expect(store.terminalFor("thr_a")).toBe("term_1");

    await store.begin("term_2");
    advance(PENDING_MS);
    expect(store.mayUse("term_2", "thr_b")).toBe(false);
  });

  it("keeps one thread per tab: a new one replaces the old, and dropping the tab forgets it", async () => {
    const { store, saved } = links([{ terminalId: "term_1", threadId: "thr_old", createdAt: 0 }]);
    await store.load();
    expect(store.threadFor("term_1")).toBe("thr_old");
    await store.begin("term_1");
    await store.bind("term_1", "thr_new");
    expect(store.mayUse("term_1", "thr_old")).toBe(false);
    expect(store.threadFor("term_1")).toBe("thr_new");
    await store.drop("term_1");
    expect(store.threadFor("term_1")).toBeNull();
    expect(saved.at(-1)).toEqual([]);
  });

  it("applies changes in order, each on the one before", async () => {
    const { store } = links();
    await store.load();
    await Promise.all([store.begin("term_1"), store.begin("term_2"), store.bind("term_1", "thr_a"), store.drop("term_2")]);
    expect(store.all()).toEqual([{ terminalId: "term_1", threadId: "thr_a", createdAt: 1_000 }]);
  });
});
