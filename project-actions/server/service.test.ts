/** The service over fake ports: what a thread lists, and when a run starts, shows or replaces a terminal. */
import { describe, expect, it } from "vitest";

import { FINISHED_MARKER } from "./command";
import { ActionError, createActionsService, type FileRead, type FileWrite, type Runs, type TerminalState, type WorkspaceLookup } from "./service";

const ACTIONS = JSON.stringify({
  actions: [
    { name: "Dev server", command: "npm run dev", description: "Vite" },
    { name: "Test", command: "npm test", cwd: "web" },
  ],
});

const text = (content: string): FileRead => ({ kind: "text", text: content, sha256: "old-sha" });

function setup(options: { file?: FileRead; workspace?: WorkspaceLookup } = {}) {
  let file: FileRead = options.file ?? text(ACTIONS);
  const writes: { hostId: string; path: string; relativePath: string; content: string; expectedSha256: string | null }[] = [];
  let writeAnswer: FileWrite = { outcome: "written", sha256: "new-sha" };
  const terminals = new Map<string, TerminalState & { tail: string }>();
  const runs = new Map<string, Runs>();
  const created: { threadId: string; title: string; argv: string[] }[] = [];
  const closed: string[] = [];
  const reads: { hostId: string; path: string; relativePath: string }[] = [];
  let next = 0;
  const service = createActionsService({
    workspace: async () => options.workspace ?? { ok: true, workspace: { hostId: "mini", path: "/work/repo", branch: "feature" } },
    readFile: async (workspace, relativePath) => {
      reads.push({ hostId: workspace.hostId, path: workspace.path, relativePath });
      return file;
    },
    writeFile: async (workspace, relativePath, content, expectedSha256) => {
      writes.push({ hostId: workspace.hostId, path: workspace.path, relativePath, content, expectedSha256 });
      return writeAnswer;
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
    writes,
    setFile: (value: FileRead) => {
      file = value;
    },
    setWriteAnswer: (value: FileWrite) => {
      writeAnswer = value;
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
    expect(await setup({ file: text("{") }).service.list("thr_1")).toMatchObject({ state: "invalid", problem: { line: 1 } });
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
    setFile(text(JSON.stringify({ actions: [{ name: "Test", command: "npm run test:ci" }] })));
    await service.run("thr_1", "Test");
    expect(created[0]!.argv[5]).toBe("npm run test:ci");
  });

  it.each([
    ["a missing file", { kind: "missing" } as FileRead, "This workspace has no .bb/actions.json."],
    ["an invalid file", text("{"), "Expected a closing brace (.bb/actions.json, line 1, column 2)"],
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
    const { service, created } = setup({ workspace: { ok: true, workspace: { hostId: "pc", path: "C:\\repo", branch: null } } });
    await expect(service.run("thr_1", "Test")).rejects.toThrow("macOS and Linux");
    expect(created).toEqual([]);
  });

  it("goes on after a failed run", async () => {
    const { service, setFile } = setup({ file: { kind: "missing" } });
    await expect(service.run("thr_1", "Test")).rejects.toThrow();
    setFile(text(ACTIONS));
    expect(await service.run("thr_1", "Test")).toEqual({ terminalId: "term_1", outcome: "started" });
  });
});

describe("read", () => {
  it("opens the workspace's file with its hash and branch", async () => {
    expect(await setup().service.read("thr_1")).toEqual({ state: "ready", text: ACTIONS, sha256: "old-sha", branch: "feature" });
  });

  it("opens an invalid file as it is, so the editor can fix it", async () => {
    expect(await setup({ file: text("{") }).service.read("thr_1")).toEqual({ state: "ready", text: "{", sha256: "old-sha", branch: "feature" });
  });

  it("opens a missing file as none yet", async () => {
    expect(await setup({ file: { kind: "missing" } }).service.read("thr_1")).toEqual({ state: "ready", text: null, sha256: null, branch: "feature" });
  });

  it("says when it cannot read", async () => {
    expect(await setup({ file: { kind: "error", message: "denied" } }).service.read("thr_1")).toEqual({ state: "unavailable", message: "denied" });
    expect(await setup({ workspace: { ok: false, message: "offline" } }).service.read("thr_1")).toEqual({ state: "unavailable", message: "offline" });
  });
});

describe("save", () => {
  const NEXT = '{\n  "actions": [\n    {\n      "name": "Lint",\n      "command": "npm run lint"\n    }\n  ]\n}\n';

  it("writes the file in the workspace, only over the one the editor read, and leaves running actions alone", async () => {
    const { service, writes, created, closed, runs, terminals } = setup();
    await service.run("thr_1", "Dev server");
    expect(await service.save("thr_1", NEXT, "old-sha")).toEqual({ outcome: "saved", sha256: "new-sha" });
    expect(created).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(terminals.get("term_1")?.status).toBe("running");
    expect(runs.get("thr_1")).toEqual({ "Dev server": "term_1" });
    expect(writes).toEqual([{ hostId: "mini", path: "/work/repo", relativePath: ".bb/actions.json", content: NEXT, expectedSha256: "old-sha" }]);
  });

  it("creates the file when there was none", async () => {
    const { service, writes } = setup({ file: { kind: "missing" } });
    await service.save("thr_1", NEXT, null);
    expect(writes[0]?.expectedSha256).toBeNull();
  });

  it("says when the file changed on disk since it was opened", async () => {
    const { service, setWriteAnswer } = setup();
    setWriteAnswer({ outcome: "conflict" });
    expect(await service.save("thr_1", NEXT, "old-sha")).toEqual({ outcome: "conflict" });
  });

  it("never writes a file the menu would refuse", async () => {
    const { service, writes } = setup();
    await expect(service.save("thr_1", '{ "actions": [{ "name": "Lint" }] }', "old-sha")).rejects.toThrow(
      new ActionError('Not saved: Missing "command" (.bb/actions.json, line 1, column 15 (actions[0]))'),
    );
    await expect(service.save("thr_1", "{", "old-sha")).rejects.toThrow(/Not saved: Expected a closing brace/);
    expect(writes).toEqual([]);
  });

  it("refuses a file over 256 KB", async () => {
    const { service, writes } = setup();
    await expect(service.save("thr_1", `{"actions":[]}${" ".repeat(256 * 1024)}`, null)).rejects.toThrow("larger than 256 KB");
    expect(writes).toEqual([]);
  });

  it("says why it cannot reach the workspace", async () => {
    await expect(setup({ workspace: { ok: false, message: "offline" } }).service.save("thr_1", NEXT, null)).rejects.toThrow("offline");
  });
});
