import { describe, expect, it } from "vitest";

import { AgentLinkSchema, PENDING_MS, createAgentLinks, type AgentLink } from "./agent-links";

/** Plugin storage the stores share, as two copies of the plugin do across a reload. */
function storage(initial: AgentLink[] = []) {
  let stored = initial;
  const saved: AgentLink[][] = [];
  return {
    load: async () => stored,
    save: async (list: AgentLink[]) => {
      saved.push(list);
      stored = list;
    },
    saved,
    read: () => stored,
  };
}

function links(stored: AgentLink[] = [], shared = storage(stored)) {
  let clock = 1_000;
  let tokens = 0;
  const store = createAgentLinks({
    load: shared.load,
    save: shared.save,
    now: () => clock,
    newToken: () => `tok_${++tokens}_${Math.random()}`,
  });
  return { store, saved: shared.saved, shared, advance: (ms: number) => (clock += ms) };
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
    const first = store.begin("term_1");
    await Promise.all([first, store.begin("term_2"), first.then((token) => store.bind("term_1", token, "thr_a")), store.drop("term_2")]);
    expect(store.all()).toEqual([{ terminalId: "term_1", threadId: "thr_a", createdAt: 1_000, token: await first }]);
  });

  it("works on the stored list, so an old copy's late change does not undo the new copy's links", async () => {
    // A reload: the new copy loads while the old one still has a spawn under way.
    const shared = storage();
    const old = links([], shared);
    await old.store.load();
    const oldToken = await old.store.begin("term_1");
    const fresh = links([], shared);
    await fresh.store.load();
    const newToken = await fresh.store.begin("term_1");
    expect(await fresh.store.bind("term_1", newToken, "thr_new")).toBe(true);
    await fresh.store.begin("term_2");

    // The old copy's spawn answers: its token is not the stored one, and it rewrites nothing.
    expect(await old.store.bind("term_1", oldToken, "thr_old")).toBe(false);
    await old.store.dropPending("term_1", oldToken);
    expect(shared.read().map((link) => [link.terminalId, link.threadId])).toEqual([
      ["term_1", "thr_new"],
      ["term_2", null],
    ]);
  });

  it("keeps a revoked spawn out when the old copy's bind, already being saved, lands after the revocation", async () => {
    const shared = storage();
    // The old copy's saves can be held, as a slow storage write.
    let hold: Promise<void> | null = null;
    const old = createAgentLinks({
      load: shared.load,
      save: async (list) => {
        if (hold !== null) await hold;
        await shared.save(list);
      },
      now: () => 1_000,
      newToken: () => "old-token",
    });
    await old.load();
    await old.begin("term_1");
    let release = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    // The old copy has read the pending link and is saving its bind.
    const binding = old.bind("term_1", "old-token", "old-chat");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The new copy loads and revokes the pending spawn meanwhile.
    const fresh = links([], shared);
    await fresh.store.load();
    const dropped = await fresh.store.dropAllPending();
    expect(dropped).toEqual(["old-token"]);
    fresh.store.revoke(dropped);

    release();
    await binding;
    expect(shared.read()).toMatchObject([{ threadId: "old-chat", token: "old-token" }]);
    // The late save is ignored: no thread for the tab, no tools for the old chat, and the next change writes it out.
    await fresh.store.refresh();
    expect(fresh.store.threadFor("term_1")).toBeNull();
    expect(fresh.store.terminalFor("old-chat")).toBeNull();
    expect(fresh.store.mayUse("term_1", "old-chat")).toBe(false);
    await fresh.store.begin("term_2");
    expect(shared.read().map((link) => link.terminalId)).toEqual(["term_2"]);
  });

  it("writes nothing once closed, and binds nothing", async () => {
    const shared = storage();
    const { store } = links([], shared);
    await store.load();
    const token = await store.begin("term_1");
    const before = shared.saved.length;
    store.close();
    expect(await store.bind("term_1", token, "thr_a")).toBe(false);
    await expect(store.dropPending("term_1", token)).rejects.toThrow(/being unloaded/);
    await expect(store.drop("term_1")).rejects.toThrow(/being unloaded/);
    expect(shared.saved).toHaveLength(before);
  });

  it("sees what another copy saved after a refresh", async () => {
    const shared = storage();
    const mine = links([], shared);
    await mine.store.load();
    const other = links([], shared);
    await other.store.load();
    const token = await other.store.begin("term_1");
    await other.store.bind("term_1", token, "thr_a");
    expect(mine.store.terminalFor("thr_a")).toBeNull();
    await mine.store.refresh();
    expect(mine.store.terminalFor("thr_a")).toBe("term_1");
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
