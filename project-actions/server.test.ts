/**
 * The whole server against the SDK's fake host: where it reads the actions file, the terminal it
 * asks bb for, what it remembers, and its answers when bb fails. No terminal starts; bb's
 * threads, environments, files and terminals are stubs.
 */
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { FINISHED_MARKER } from "./server/command";

const ACTIONS = JSON.stringify({ actions: [{ name: "Dev server", command: "npm run dev", cwd: "web" }] });

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

async function start(
  options: { file?: string | Error; environment?: Record<string, unknown>; hostStatus?: string; base64?: boolean; write?: Record<string, unknown> } = {},
) {
  const sessions = new Map<string, { status: string; tail: string }>();
  let next = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "project-actions",
    sdk: {
      threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env_1" }) },
      environments: {
        get: async () => ({ id: "env_1", hostId: "air", path: "/Users/me/wt/feature", status: "ready", branchName: "feature", ...options.environment }) as never,
      },
      hosts: { get: async () => makeHostResponse({ id: "air", name: "MacBook Air", status: (options.hostStatus ?? "connected") as never }) },
      files: {
        read: async () => {
          const file = options.file ?? ACTIONS;
          if (file instanceof Error) throw file;
          return {
            content: options.base64 ? Buffer.from(file).toString("base64") : file,
            contentEncoding: options.base64 ? "base64" : "utf8",
            sha256: "x",
            sizeBytes: Buffer.byteLength(file),
          } as never;
        },
        write: async () => (options.write ?? { outcome: "written", sha256: "y", sizeBytes: 1 }) as never,
      },
      terminals: {
        create: async () => {
          next += 1;
          const id = `term_${next}`;
          sessions.set(id, { status: "running", tail: "" });
          return { id, status: "running" } as never;
        },
        get: async ({ terminalId }) => {
          const session = sessions.get(terminalId);
          if (session === undefined) throw httpError("Terminal session not found", 404);
          return { id: terminalId, status: session.status } as never;
        },
        output: async ({ terminalId }) =>
          ({ chunks: [{ seq: 1, dataBase64: Buffer.from(sessions.get(terminalId)?.tail ?? "").toString("base64") }], status: "running", exitCode: null, closeReason: null, nextSeq: 2, truncated: false }) as never,
        close: async ({ terminalId }) => {
          sessions.get(terminalId)!.status = "exited";
          return { id: terminalId } as never;
        },
      },
    },
  });
  await plugin(bb);
  return { bb, harness, sessions };
}

describe("project-actions server", () => {
  it("reads .bb/actions.json from the thread's workspace, on the machine that holds it", async () => {
    const { harness } = await start();
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toEqual({
      state: "ready",
      actions: [{ name: "Dev server", command: "npm run dev", cwd: "web", description: null, status: "idle" }],
    });
    expect(harness.sdk.callsTo("files.read")).toEqual([[{ hostId: "air", rootPath: "/Users/me/wt/feature", path: "/Users/me/wt/feature/.bb/actions.json" }]]);
  });

  it("reads a file bb sends as base64", async () => {
    const { harness } = await start({ base64: true });
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toMatchObject({ state: "ready" });
  });

  it("starts the action in a terminal of the thread, titled with its name, and shows it again while it runs", async () => {
    const { harness, sessions } = await start();
    expect(await harness.callRpc("run", { threadId: "thr_1", name: "Dev server" })).toEqual({ terminalId: "term_1", outcome: "started" });
    const [[create]] = harness.sdk.callsTo("terminals.create") as [[Record<string, unknown> & { start: { mode: string; argv: string[] } }]];
    expect(create).toMatchObject({ scope: { kind: "thread", threadId: "thr_1" }, title: "Dev server", cols: 120, rows: 32 });
    expect(create.start.mode).toBe("argv");
    expect(create.start.argv.slice(3, 8)).toEqual(["bb-project-actions", "/Users/me/wt/feature", "./web", "npm run dev", "Dev server"]);

    expect(await harness.callRpc("run", { threadId: "thr_1", name: "Dev server" })).toEqual({ terminalId: "term_1", outcome: "focused" });
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toMatchObject({ actions: [{ status: "running" }] });

    sessions.get("term_1")!.tail = `done${FINISHED_MARKER}`;
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toMatchObject({ actions: [{ status: "finished" }] });
    expect(await harness.callRpc("run", { threadId: "thr_1", name: "Dev server" })).toEqual({ terminalId: "term_2", outcome: "restarted" });
    expect(harness.sdk.callsTo("terminals.close")).toEqual([[{ terminalId: "term_1", mode: "force" }]]);
  });

  it("forgets a thread's runs when the thread is archived", async () => {
    const { bb, harness } = await start();
    await harness.callRpc("run", { threadId: "thr_1", name: "Dev server" });
    expect(await bb.storage.kv.get("runs:thr_1")).toEqual({ "Dev server": "term_1" });
    await harness.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_1" }) });
    expect(await bb.storage.kv.get("runs:thr_1")).toBeUndefined();
  });

  it("says the file is missing when bb cannot find it", async () => {
    const { harness } = await start({ file: httpError("File not found", 404) });
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toEqual({ state: "missing" });
    await expect(harness.callRpc("run", { threadId: "thr_1", name: "Dev server" })).rejects.toThrow("This workspace has no .bb/actions.json.");
  });

  it("says why the file could not be read", async () => {
    const { harness } = await start({ file: new Error("permission denied") });
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toEqual({ state: "unavailable", message: ".bb/actions.json could not be read: permission denied" });
  });

  it("refuses a file over 256 KB", async () => {
    const { harness } = await start({ file: `{"actions":[]}${" ".repeat(256 * 1024)}` });
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toEqual({ state: "unavailable", message: ".bb/actions.json is larger than 256 KB." });
  });

  it.each([
    [{ environment: { status: "destroyed", path: null } }, "This thread's workspace is gone."],
    [{ environment: { status: "provisioning" } }, "This thread's workspace is still being set up."],
    [{ hostStatus: "disconnected" }, "MacBook Air is offline, so its workspace cannot be read."],
  ])("says when the workspace cannot be read (%o)", async (options, message) => {
    const { harness } = await start(options);
    expect(await harness.callRpc("list", { threadId: "thr_1" })).toEqual({ state: "unavailable", message });
  });

  it("opens the file for the editor with its hash and the workspace's branch", async () => {
    const { harness } = await start();
    expect(await harness.callRpc("read", { threadId: "thr_1" })).toEqual({ state: "ready", text: ACTIONS, sha256: "x", branch: "feature" });
  });

  it("saves into the workspace on its machine, creating .bb/, only over the file the editor read", async () => {
    const { harness } = await start();
    const text = '{\n  "actions": []\n}\n';
    expect(await harness.callRpc("save", { threadId: "thr_1", text, expectedSha256: "x" })).toEqual({ outcome: "saved", sha256: "y" });
    expect(harness.sdk.callsTo("files.write")).toEqual([
      [{ hostId: "air", rootPath: "/Users/me/wt/feature", path: "/Users/me/wt/feature/.bb/actions.json", content: text, createParents: true, expectedSha256: "x" }],
    ]);
  });

  it("answers a conflict when the file changed on disk", async () => {
    const { harness } = await start({ write: { outcome: "conflict", currentSha256: "z" } });
    expect(await harness.callRpc("save", { threadId: "thr_1", text: '{ "actions": [] }', expectedSha256: "x" })).toEqual({ outcome: "conflict" });
  });

  it("refuses to save an invalid file", async () => {
    const { harness } = await start();
    await expect(harness.callRpc("save", { threadId: "thr_1", text: "{", expectedSha256: "x" })).rejects.toThrow(/Not saved/);
    expect(harness.sdk.callsTo("files.write")).toEqual([]);
  });
});
