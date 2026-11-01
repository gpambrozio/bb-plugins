import { describe, expect, it } from "vitest";

import { MAX_TABS, OPENING_GRACE_MS, type Closing, type HostChoice, type Tab } from "../shared/tabs";
import { createTerminalsService, type TerminalSessionInfo, type TerminalsPorts } from "./service";

function setup(
  options: {
    hosts?: HostChoice[];
    saveFails?: boolean;
    closeFails?: boolean;
    retitleFails?: boolean;
    createFails?: boolean;
    /** Keeps each create waiting until the test calls the function it leaves here. */
    holdCreates?: (() => void)[];
  } = {},
) {
  const state = {
    tabs: [] as Tab[],
    closing: [] as Closing[],
    sessions: new Map<string, TerminalSessionInfo>(),
    closed: [] as string[],
    titles: [] as [string, string][],
    published: 0,
    warnings: [] as string[],
    nextId: 1,
    now: 1_000,
  };
  const ports: TerminalsPorts = {
    load: async () => state.tabs.map((tab) => ({ ...tab })),
    save: async (tabs) => {
      if (options.saveFails) throw new Error("storage is full");
      state.tabs = tabs;
    },
    loadClosing: async () => state.closing.map((entry) => ({ ...entry })),
    saveClosing: async (closing) => {
      state.closing = closing;
    },
    hosts: async () => options.hosts ?? [{ id: "mini", name: "Mac mini" }],
    newTerminalId: () => `term_${state.nextId++}`,
    createTerminal: async ({ terminalId }) => {
      if (options.holdCreates) await new Promise<void>((resolve) => options.holdCreates!.push(resolve));
      if (options.createFails) throw new Error("the machine did not answer");
      const session: TerminalSessionInfo = { id: terminalId, status: "running", exitCode: null };
      state.sessions.set(session.id, session);
      return session;
    },
    getTerminal: async (terminalId) => state.sessions.get(terminalId) ?? null,
    renameTerminal: async (terminalId, title) => {
      if (options.retitleFails) throw new Error("bb refused the title");
      state.titles.push([terminalId, title]);
    },
    closeTerminal: async (terminalId) => {
      const session = state.sessions.get(terminalId);
      if (session === undefined || session.status === "exited") throw new Error("terminal_not_running");
      if (options.closeFails) throw new Error("host is offline");
      session.status = "exited";
      state.closed.push(terminalId);
    },
    publish: () => void (state.published += 1),
    now: () => state.now,
    warn: (message) => void state.warnings.push(message),
  };
  return { state, service: createTerminalsService(ports) };
}

describe("open", () => {
  it("starts a shell on the machine and adds its tab at the end", async () => {
    const { state, service } = setup();
    const first = await service.open({ hostId: "mini", cols: 80, rows: 24 });
    const second = await service.open({ hostId: "mini", cols: 80, rows: 24 });
    expect(first).toEqual({
      terminalId: "term_1",
      hostId: "mini",
      hostName: "Mac mini",
      createdAt: 1_000,
      name: null,
      status: "running",
      exitCode: null,
    });
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

  it("starts no shell when its tab cannot be saved", async () => {
    const { state, service } = setup({ saveFails: true });
    await expect(service.open({ hostId: "mini", cols: 80, rows: 24 })).rejects.toThrow(/storage is full/);
    expect(state.sessions.size).toBe(0);
    expect(state.published).toBe(0);
  });

  it("drops the tab again when bb cannot start its shell", async () => {
    const { state, service } = setup({ createFails: true });
    await expect(service.open({ hostId: "mini", cols: 80, rows: 24 })).rejects.toThrow(/did not answer/);
    expect(state.tabs).toEqual([]);
  });

  it("keeps both tabs when two open at once", async () => {
    const { state, service } = setup();
    await Promise.all([service.open({ hostId: "mini", cols: 80, rows: 24 }), service.open({ hostId: "mini", cols: 80, rows: 24 })]);
    expect(state.tabs).toHaveLength(2);
  });

  it("holds the tab limit when the last free places are asked for at once", async () => {
    const holdCreates: (() => void)[] = [];
    const { state, service } = setup({ holdCreates });
    const filling = Array.from({ length: MAX_TABS - 1 }, () => service.open({ hostId: "mini", cols: 80, rows: 24 }));
    await expect.poll(() => holdCreates.length).toBe(MAX_TABS - 1);
    for (const release of holdCreates.splice(0)) release();
    await Promise.all(filling);
    // Both clients press + with one place left; bb is slow, so neither shell exists when the other checks.
    const racing = [service.open({ hostId: "mini", cols: 80, rows: 24 }), service.open({ hostId: "mini", cols: 80, rows: 24 })];
    const settled = Promise.allSettled(racing);
    await expect.poll(() => holdCreates.length).toBe(1);
    for (const release of holdCreates.splice(0)) release();
    const results = await settled;
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.sessions.size).toBe(MAX_TABS);
  });

  it("lists a tab bb has not made the shell of yet as opening, and as ended once that has taken too long", async () => {
    const holdCreates: (() => void)[] = [];
    const { state, service } = setup({ holdCreates });
    const opening = service.open({ hostId: "mini", cols: 80, rows: 24 });
    await expect.poll(() => holdCreates.length).toBe(1);
    expect((await service.list()).map((tab) => tab.status)).toEqual(["opening"]);
    await service.prune();
    expect(state.tabs).toHaveLength(1);
    state.now += OPENING_GRACE_MS;
    expect((await service.list()).map((tab) => tab.status)).toEqual(["ended"]);
    holdCreates[0]!();
    await opening;
  });

  it("ends the shell of a tab closed while bb was still opening it", async () => {
    const holdCreates: (() => void)[] = [];
    const { state, service } = setup({ holdCreates });
    const opening = service.open({ hostId: "mini", cols: 80, rows: 24 });
    await expect.poll(() => holdCreates.length).toBe(1);
    await service.close("term_1");
    expect(state.tabs).toEqual([]);
    holdCreates[0]!();
    await expect(opening).rejects.toThrow(/closed while it was opening/);
    expect(state.closed).toEqual(["term_1"]);
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

describe("rename", () => {
  it("stores the trimmed name, tells every client, and gives bb's terminal the same title", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    const before = state.published;
    await service.rename("term_2", "  dev   server ");
    expect(state.tabs.map((tab) => tab.name)).toEqual([null, "dev server"]);
    expect(state.published).toBe(before + 1);
    expect(state.titles).toEqual([["term_2", "dev server"]]);
    expect((await service.list())[1]?.name).toBe("dev server");
  });

  it("brings back the default title for an empty name", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.rename("term_1", "logs");
    await service.rename("term_1", "   ");
    expect(state.tabs[0]?.name).toBeNull();
    await service.rename("term_1", "logs");
    await service.rename("term_1", null);
    expect(state.tabs[0]?.name).toBeNull();
    expect(state.titles.at(-1)).toEqual(["term_1", "Mac mini"]);
  });

  it("cuts a long name to the limit", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.rename("term_1", "x".repeat(500));
    expect(state.tabs[0]?.name).toHaveLength(80);
  });

  it("changes nothing for the same name", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.rename("term_1", "logs");
    const before = state.published;
    await service.rename("term_1", " logs ");
    expect(state.published).toBe(before);
  });

  it("refuses a tab that is closed", async () => {
    const { service } = setup();
    await expect(service.rename("term_9", "logs")).rejects.toThrow(/closed/);
  });

  it("keeps the name when bb refuses the terminal's title", async () => {
    const { state, service } = setup({ retitleFails: true });
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.rename("term_1", "logs");
    expect(state.tabs[0]?.name).toBe("logs");
    expect(state.warnings.some((warning) => warning.includes("retitle"))).toBe(true);
  });

  it("keeps a name given while another tab opens", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await Promise.all([service.rename("term_1", "logs"), service.open({ hostId: "mini", cols: 80, rows: 24 })]);
    expect(state.tabs.map((tab) => [tab.terminalId, tab.name])).toEqual([
      ["term_1", "logs"],
      ["term_2", null],
    ]);
  });
});

describe("a tab closed before bb has made its shell", () => {
  async function closedWhileOpening() {
    const holdCreates: (() => void)[] = [];
    const setupResult = setup({ holdCreates });
    const opening = setupResult.service.open({ hostId: "mini", cols: 80, rows: 24 });
    opening.catch(() => undefined);
    await expect.poll(() => holdCreates.length).toBe(1);
    await setupResult.service.close("term_1");
    return { ...setupResult, holdCreates, opening };
  }

  it("is remembered until bb has the shell, which is then ended", async () => {
    const { state, service, holdCreates } = await closedWhileOpening();
    expect(state.tabs).toEqual([]);
    expect(state.closing).toEqual([{ terminalId: "term_1", createdAt: 1_000 }]);
    // Nothing to end yet, and it may still come.
    expect(await service.settleClosing()).toBe(true);
    expect(state.closing).toHaveLength(1);
    holdCreates[0]!();
    await expect.poll(() => state.sessions.has("term_1")).toBe(true);
    expect(await service.settleClosing()).toBe(false);
    expect(state.sessions.get("term_1")?.status).toBe("exited");
    expect(state.closing).toEqual([]);
  });

  it("is forgotten once bb has taken too long to have made it", async () => {
    const { state, service } = await closedWhileOpening();
    state.now += OPENING_GRACE_MS;
    expect(await service.settleClosing()).toBe(false);
    expect(state.closing).toEqual([]);
  });

  it("is kept when bb cannot end the shell yet", async () => {
    const holdCreates: (() => void)[] = [];
    const options = { holdCreates, closeFails: false };
    const { state, service } = setup(options);
    const opening = service.open({ hostId: "mini", cols: 80, rows: 24 });
    opening.catch(() => undefined);
    await expect.poll(() => holdCreates.length).toBe(1);
    await service.close("term_1");
    // bb makes the shell, but its machine stops answering before it can be ended.
    state.sessions.set("term_1", { id: "term_1", status: "running", exitCode: null });
    options.closeFails = true;
    expect(await service.settleClosing()).toBe(true);
    expect(state.closing).toHaveLength(1);
    expect(state.warnings.some((warning) => warning.includes("term_1"))).toBe(true);
    options.closeFails = false;
    expect(await service.settleClosing()).toBe(false);
    expect(state.sessions.get("term_1")?.status).toBe("exited");
  });

  it("needs no record for a tab whose shell bb already has", async () => {
    const { state, service } = setup();
    await service.open({ hostId: "mini", cols: 80, rows: 24 });
    await service.close("term_1");
    expect(state.closing).toEqual([]);
    expect(await service.settleClosing()).toBe(false);
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
    // bb no longer knows term_3, and it is past the time a new tab gets to open.
    state.now += OPENING_GRACE_MS;
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
    state.now += OPENING_GRACE_MS;
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
