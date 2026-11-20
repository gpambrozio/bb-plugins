/** The service over fake ports: what a thread lists, and when a run starts, shows or replaces a terminal. */
import { describe, expect, it } from "vitest";

import { FINISHED_MARKER } from "./command";
import { ActionError, createActionsService, type FileRead, type Runs, type TerminalState, type WorkspaceLookup } from "./service";

const ACTIONS = JSON.stringify({
  actions: [
    { name: "Dev server", command: "npm run dev", description: "Vite" },
    { name: "Test", command: "npm test", cwd: "web" },
  ],
});

function setup(options: { file?: FileRead; workspace?: WorkspaceLookup } = {}) {
  let file: FileRead = options.file ?? { kind: "text", text: ACTIONS };
  const terminals = new Map<string, TerminalState & { tail: string }>();
  const runs = new Map<string, Runs>();
  const created: { threadId: string; title: string; argv: string[] }[] = [];
  const closed: string[] = [];
  const reads: { hostId: string; path: string; relativePath: string }[] = [];
  let next = 0;
  const service = createActionsService({
    workspace: async () => options.workspace ?? { ok: true, workspace: { hostId: "mini", path: "/work/repo" } },
    readFile: async (workspace, relativePath) => {
      reads.push({ ...workspace, relativePath });
      return file;
    },
    getTerminal: async (id) => terminals.get(id) ?? null,
    outputTail: async (id) => terminals.get(id)?.tail ?? "",
    createTerminal: async (input) => {
      // Lets a second run that was queued behind this one see it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      created.push(input);
      next += 1;
      const id = `term_${next}`;
      terminals.set(id, { status: "running", tail: "" });
      return { id };
    },
    closeTerminal: async (id) => {
      closed.push(id);
      terminals.set(id, { status: "exited", tail: "" });
    },
    loadRuns: async (threadId) => ({ ...(runs.get(threadId) ?? {}) }),
    saveRuns: async (threadId, value) => {
      runs.set(threadId, value);
    },
  });
  return {
    service,
    terminals,
    runs,
    created,
    closed,
    reads,
    setFile: (value: FileRead) => {
      file = value;
    },
  };
}

describe("list", () => {
  it("reads .bb/actions.json from the thread's workspace on its machine", async () => {
    const { service, reads } = setup();
    expect(await service.list("thr_1")).toEqual({
      state: "ready",
      actions: [
        { name: "Dev server", command: "npm run dev", cwd: null, description: "Vite", status: "idle" },
        { name: "Test", command: "npm test", cwd: "web", description: null, status: "idle" },
      ],
    });
    expect(reads).toEqual([{ hostId: "mini", path: "/work/repo", relativePath: ".bb/actions.json" }]);
  });

  it("says when the file is missing, invalid or unreadable, and when there is no workspace", async () => {
    expect(await setup({ file: { kind: "missing" } }).service.list("thr_1")).toEqual({ state: "missing" });
    expect(await setup({ file: { kind: "text", text: "{" } }).service.list("thr_1")).toMatchObject({ state: "invalid", problem: { line: 1 } });
    expect(await setup({ file: { kind: "error", message: "denied" } }).service.list("thr_1")).toEqual({ state: "unavailable", message: "denied" });
    expect(await setup({ workspace: { ok: false, message: "offline" } }).service.list("thr_1")).toEqual({ state: "unavailable", message: "offline" });
  });

  it("shows each action's last run: running, finished, or gone", async () => {
    const { service, terminals, runs } = setup();
    terminals.set("term_a", { status: "running", tail: "listening on :5173" });
    terminals.set("term_b", { status: "running", tail: `ok${FINISHED_MARKER}` });
    runs.set("thr_1", { "Dev server": "term_a", Test: "term_b" });
    const list = await service.list("thr_1");
    expect(list.state === "ready" && list.actions.map((action) => action.status)).toEqual(["running", "finished"]);
    terminals.set("term_a", { status: "exited", tail: "" });
    terminals.delete("term_b");
    const later = await service.list("thr_1");
    expect(later.state === "ready" && later.actions.map((action) => action.status)).toEqual(["idle", "idle"]);
  });
});

describe("run", () => {
  it("starts a terminal in the thread, titled with the action's name, running it in its folder", async () => {
    const { service, created, runs } = setup();
    expect(await service.run("thr_1", "Test")).toEqual({ terminalId: "term_1", outcome: "started" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ threadId: "thr_1", title: "Test" });
    expect(created[0]!.argv.slice(3)).toEqual(["bb-project-actions", "/work/repo/web", "npm test", "Test"]);
    expect(runs.get("thr_1")).toEqual({ Test: "term_1" });
  });

  it("shows the terminal of an action that is still running instead of starting another", async () => {
    const { service, created } = setup();
    await service.run("thr_1", "Dev server");
    expect(await service.run("thr_1", "Dev server")).toEqual({ terminalId: "term_1", outcome: "focused" });
    expect(created).toHaveLength(1);
  });

  it("starts one terminal for two runs at once", async () => {
    const { service, created } = setup();
    const [first, second] = await Promise.all([service.run("thr_1", "Dev server"), service.run("thr_1", "Dev server")]);
    expect(first).toEqual({ terminalId: "term_1", outcome: "started" });
    expect(second).toEqual({ terminalId: "term_1", outcome: "focused" });
    expect(created).toHaveLength(1);
  });

  it("keeps threads apart", async () => {
    const { service, created } = setup();
    await service.run("thr_1", "Dev server");
    expect(await service.run("thr_2", "Dev server")).toEqual({ terminalId: "term_2", outcome: "started" });
    expect(created.map((input) => input.threadId)).toEqual(["thr_1", "thr_2"]);
  });

  it("replaces a finished run's terminal with a new run", async () => {
    const { service, terminals, closed, runs } = setup();
    await service.run("thr_1", "Test");
    terminals.set("term_1", { status: "running", tail: `3 passed${FINISHED_MARKER}` });
    expect(await service.run("thr_1", "Test")).toEqual({ terminalId: "term_2", outcome: "restarted" });
    expect(closed).toEqual(["term_1"]);
    expect(runs.get("thr_1")).toEqual({ Test: "term_2" });
  });

  it("starts again once the last run's terminal is closed, and forgets closed ones", async () => {
    const { service, terminals, runs, closed } = setup();
    await service.run("thr_1", "Test");
    await service.run("thr_1", "Dev server");
    terminals.set("term_1", { status: "exited", tail: "" });
    terminals.delete("term_2");
    expect(await service.run("thr_1", "Test")).toEqual({ terminalId: "term_3", outcome: "started" });
    expect(closed).toEqual([]);
    expect(runs.get("thr_1")).toEqual({ Test: "term_3" });
  });

  it("runs what the file says now", async () => {
    const { service, created, setFile } = setup();
    setFile({ kind: "text", text: JSON.stringify({ actions: [{ name: "Test", command: "npm run test:ci" }] }) });
    await service.run("thr_1", "Test");
    expect(created[0]!.argv[5]).toBe("npm run test:ci");
  });

  it.each([
    ["a missing file", { kind: "missing" } as FileRead, "This workspace has no .bb/actions.json."],
    ["an invalid file", { kind: "text", text: "{" } as FileRead, "Expected a closing brace (.bb/actions.json, line 1, column 2)"],
  ])("refuses to run with %s", async (_label, file, message) => {
    const { service, created } = setup({ file });
    await expect(service.run("thr_1", "Test")).rejects.toThrow(new ActionError(message));
    expect(created).toEqual([]);
  });

  it("refuses an action the file no longer has", async () => {
    const { service } = setup();
    await expect(service.run("thr_1", "Deploy")).rejects.toThrow('.bb/actions.json has no action named "Deploy" any more.');
  });

  it("refuses a Windows workspace, which has no /bin/sh", async () => {
    const { service, created } = setup({ workspace: { ok: true, workspace: { hostId: "pc", path: "C:\\repo" } } });
    await expect(service.run("thr_1", "Test")).rejects.toThrow("macOS and Linux");
    expect(created).toEqual([]);
  });

  it("goes on after a failed run", async () => {
    const { service, setFile } = setup({ file: { kind: "missing" } });
    await expect(service.run("thr_1", "Test")).rejects.toThrow();
    setFile({ kind: "text", text: ACTIONS });
    expect(await service.run("thr_1", "Test")).toEqual({ terminalId: "term_1", outcome: "started" });
  });
});
