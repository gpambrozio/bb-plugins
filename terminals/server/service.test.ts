import { describe, expect, it } from "vitest";

import { MAX_TABS, type HostChoice, type Tab } from "../shared/tabs";
import { createTerminalsService, type TerminalSessionInfo, type TerminalsPorts } from "./service";

function setup(options: { hosts?: HostChoice[]; saveFails?: boolean; closeFails?: boolean } = {}) {
  const state = {
    tabs: [] as Tab[],
    sessions: new Map<string, TerminalSessionInfo>(),
    closed: [] as string[],
    published: 0,
    warnings: [] as string[],
    nextId: 1,
  };
  const ports: TerminalsPorts = {
    load: async () => state.tabs.map((tab) => ({ ...tab })),
    save: async (tabs) => {
      if (options.saveFails) throw new Error("storage is full");
      state.tabs = tabs;
    },
    hosts: async () => options.hosts ?? [{ id: "mini", name: "Mac mini" }],
    createTerminal: async () => {
      const session: TerminalSessionInfo = { id: `term_${state.nextId++}`, status: "running", exitCode: null };
      state.sessions.set(session.id, session);
      return session;
    },
    getTerminal: async (terminalId) => state.sessions.get(terminalId) ?? null,
    closeTerminal: async (terminalId) => {
      const session = state.sessions.get(terminalId);
      if (session === undefined || session.status === "exited") throw new Error("terminal_not_running");
      if (options.closeFails) throw new Error("host is offline");
      session.status = "exited";
      state.closed.push(terminalId);
    },
    publish: () => void (state.published += 1),
    now: () => 1_000,
    warn: (message) => void state.warnings.push(message),
  };
  return { state, service: createTerminalsService(ports) };
}

describe("open", () => {
  it("starts a shell on the machine and adds its tab at the end", async () => {
    const { state, service } = setup();
    const first = await service.open({ hostId: "mini", cols: 80, rows: 24 });
    const second = await service.open({ hostId: "mini", cols: 80, rows: 24 });
    expect(first).toEqual({ terminalId: "term_1", hostId: "mini", hostName: "Mac mini", createdAt: 1_000, status: "running", exitCode: null });
    expect(state.tabs.map((tab) => tab.terminalId)).toEqual(["term_1", "term_2"]);
    expect(second.terminalId).toBe("term_2");
    expect(state.published).toBe(2);
  });

  it("refuses a machine that is not connected", async () => {
    const { state, service } = setup();
    await expect(service.open({ hostId: "gone", cols: 80, rows: 24 })).rejects.toThrow(/not connected/);
    expect(state.sessions.size).toBe(0);
  });

  it("refuses past the tab limit", async () => {
    const { state, service } = setup();
    for (let index = 0; index < MAX_TABS; index += 1) await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await expect(service.open({ hostId: "mini", cols: 80, rows: 24 })).rejects.toThrow(/At most/);
    expect(state.sessions.size).toBe(MAX_TABS);
  });

  it("ends the shell when its tab cannot be saved", async () => {
    const { state, service } = setup({ saveFails: true });
    await expect(service.open({ hostId: "mini", cols: 80, rows: 24 })).rejects.toThrow(/storage is full/);
    expect(state.closed).toEqual(["term_1"]);
    expect(state.published).toBe(0);
  });

  it("keeps both tabs when two open at once", async () => {
    const { state, service } = setup();
    await Promise.all([service.open({ hostId: "mini", cols: 80, rows: 24 }), service.open({ hostId: "mini", cols: 80, rows: 24 })]);
    expect(state.tabs).toHaveLength(2);
  });
});

describe("close", () => {
  it("ends the shell and removes its tab", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.close("term_1");
    expect(state.closed).toEqual(["term_1"]);
    expect(state.tabs.map((tab) => tab.terminalId)).toEqual(["term_2"]);
  });

  it("removes the tab of a shell that has already ended", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    state.sessions.get("term_1")!.status = "exited";
    await service.close("term_1");
    expect(state.tabs).toEqual([]);
  });

  it("removes the tab of a session bb no longer knows", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    state.sessions.delete("term_1");
    await service.close("term_1");
    expect(state.tabs).toEqual([]);
  });

  it("keeps the tab when its running shell could not be ended", async () => {
    const { state, service } = setup({ closeFails: true });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await expect(service.close("term_1")).rejects.toThrow(/offline/);
    expect(state.tabs).toHaveLength(1);
  });

  it("succeeds quietly for a tab that is already gone", async () => {
    const { state, service } = setup();
    await service.close("term_9");
    expect(state.published).toBe(0);
  });
});

describe("list", () => {
  it("reports where each tab's shell is", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    state.sessions.get("term_1")!.status = "disconnected";
    Object.assign(state.sessions.get("term_2")!, { status: "exited", exitCode: 0 });
    state.sessions.delete("term_3");
    const tabs = await service.list();
    expect(tabs.map((tab) => [tab.terminalId, tab.status, tab.exitCode])).toEqual([
      ["term_1", "disconnected", null],
      ["term_2", "ended", 0],
      ["term_3", "ended", null],
    ]);
  });
});

describe("prune", () => {
  it("drops the tabs of ended shells and keeps the rest in order", async () => {
    const { state, service } = setup();
    for (let index = 0; index < 4; index += 1) await service.open({ hostId: "mini", cols: 80, rows: 24 });
    state.sessions.get("term_2")!.status = "exited";
    state.sessions.delete("term_3");
    state.sessions.get("term_4")!.status = "disconnected";
    const before = state.published;
    await service.prune();
    expect(state.tabs.map((tab) => tab.terminalId)).toEqual(["term_1", "term_4"]);
    expect(state.published).toBe(before + 1);
  });

  it("changes nothing when every shell is alive", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    const before = state.published;
    await service.prune();
    expect(state.tabs).toHaveLength(1);
    expect(state.published).toBe(before);
  });
});
