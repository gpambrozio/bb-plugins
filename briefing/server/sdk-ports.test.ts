import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";

import { gatherBriefing, gatherThread } from "./gather";
import { isMissingFile, sdkPorts } from "./sdk-ports";

type Sdk = BbPluginApi["sdk"];

/** Every SDK method the briefing may call. Anything else — a send, a write, an update — fails the test. */
const READS = new Set([
  "threads.list",
  "threads.experimental_listDescendants",
  "threads.events.list",
  "threads.conversationOutline",
  "threads.output",
  "projects.list",
  "files.read",
  "plugins.list",
  "plugins.callRpc",
]);

function listRow(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: id.replace(/^thr_/, ""),
    titleFallback: null,
    projectId: "proj_a",
    parentThreadId: null,
    archivedAt: null,
    status: "idle",
    runtime: { displayStatus: "idle" },
    hasPendingInteraction: false,
    updatedAt: 1,
    environmentHostId: "host_mac",
    environmentPath: "/w",
    ...patch,
  };
}

const ANSWERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  "threads.list": (args) =>
    args.threadIds !== undefined ? (args.threadIds as string[]).map((id) => listRow(id, { parentThreadId: "thr_root" })) : [listRow("thr_root")],
  "threads.experimental_listDescendants": (args) => ({ threads: (args.threadIds as string[]).map((threadId) => ({ threadId, descendantIds: ["thr_kid"] })) }),
  "threads.events.list": () => [{ seq: 1, data: { initiator: "user", systemMessageKind: "unlabeled", input: [{ type: "text", text: "hello" }] } }],
  "threads.conversationOutline": () => ({ items: [{ id: "a", role: "assistant", preview: "hi there", attachmentSummary: null }], maxSeq: 2 }),
  "threads.output": () => ({ output: "blocked: waiting" }),
  "projects.list": () => [{ id: "proj_a", name: "Alpha", sources: [{ hostId: "host_mac", path: "/src", isDefault: true }] }],
  "files.read": (args) => {
    if (args.path === "/src/AGENTS.md") return { content: Buffer.from("Alpha does things.").toString("base64"), contentEncoding: "base64" };
    throw Object.assign(new Error("not found"), { status: 404 });
  },
  "plugins.list": () => ({ plugins: [{ id: "firstmate-crew", enabled: true, status: "running" }] }),
  "plugins.callRpc": (args) => {
    const schema = args.outputSchema as { parse(value: unknown): unknown };
    // A first mate that is not a root thread here, so the project is described from its files.
    return schema.parse({ mate: { threadId: "thr_elsewhere" }, cards: [], suggestions: [], home: "/h", watches: [] });
  },
};

/** A fake `bb.sdk` that records the path of every method called and answers from `ANSWERS`. */
function recordingSdk(calls: { path: string; args: Record<string, unknown> }[], overrides: typeof ANSWERS = {}): Sdk {
  const at = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => at(path === "" ? String(key) : `${path}.${String(key)}`),
      apply: async (_target, _self, [args]) => {
        calls.push({ path, args: (args ?? {}) as Record<string, unknown> });
        const answer = overrides[path] ?? ANSWERS[path];
        if (answer === undefined) throw new Error(`unexpected call ${path}`);
        return answer((args ?? {}) as Record<string, unknown>);
      },
    });
  return at("") as Sdk;
}

describe("sdkPorts", () => {
  it("only reads: every SDK call a briefing and a thread detail make is a read", async () => {
    const calls: { path: string; args: Record<string, unknown> }[] = [];
    const ports = sdkPorts(recordingSdk(calls), undefined);
    const briefing = await gatherBriefing(ports);
    await gatherThread(ports, "thr_root");
    expect(calls.map((call) => call.path).filter((path) => !READS.has(path))).toEqual([]);

    expect(briefing.threads[0]).toMatchObject({ id: "thr_root", opening: "hello", lastAgent: "hi there", childCount: 1, isFirstMate: false });
    expect(calls.some((call) => call.path === "plugins.callRpc" && call.args.pluginId === "firstmate-crew" && call.args.method === "fleet.load")).toBe(true);
    expect(briefing.threads[0]?.flaggedChildren).toEqual([{ id: "thr_kid", title: "kid", state: "blocked", detail: "waiting" }]);
    expect(briefing.projects).toEqual([{ id: "proj_a", name: "Alpha", description: "Alpha does things.", source: "AGENTS.md" }]);
  });

  it("asks bb for root threads that are not archived, and pages events at most 100 at a time", async () => {
    const calls: { path: string; args: Record<string, unknown> }[] = [];
    await gatherBriefing(sdkPorts(recordingSdk(calls), undefined));
    const roots = calls.find((call) => call.path === "threads.list" && call.args.threadIds === undefined);
    expect(roots?.args).toMatchObject({ hasParent: false, archived: false });
    const events = calls.filter((call) => call.path === "threads.events.list");
    expect(events.every((call) => Number(call.args.limit) <= 100)).toBe(true);
    expect(events.every((call) => JSON.stringify(call.args.types) === '["client/turn/requested"]')).toBe(true);
    expect(calls.find((call) => call.path === "projects.list")?.args).toMatchObject({ includePersonal: true });
  });

  it("gives every call a signal that ends with the caller", async () => {
    const calls: { path: string; args: Record<string, unknown> }[] = [];
    const caller = new AbortController();
    await gatherBriefing(sdkPorts(recordingSdk(calls), caller.signal));
    const signals = calls.map((call) => call.args.signal as AbortSignal);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    caller.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("skips FirstMate without a word when firstmate-crew is not installed or is off", async () => {
    for (const plugins of [[], [{ id: "firstmate-crew", enabled: false, status: "disabled" }]]) {
      const calls: { path: string; args: Record<string, unknown> }[] = [];
      const sdk = recordingSdk(calls);
      const ports = sdkPorts(new Proxy(sdk, { get: (target, key) => (key === "plugins" ? { list: async () => ({ plugins }) } : Reflect.get(target, key)) }), undefined);
      expect(await ports.fleet()).toEqual({ ok: false, reason: "" });
    }
  });
});

describe("sdkPorts reads that need care", () => {
  const ports = (overrides: typeof ANSWERS, calls: { path: string; args: Record<string, unknown> }[] = []) => sdkPorts(recordingSdk(calls, overrides), undefined);

  it("falls back to the thread's last message of its own when its latest turn wrote none", async () => {
    const calls: { path: string; args: Record<string, unknown> }[] = [];
    const reply = await ports(
      {
        "threads.output": () => ({ output: null }),
        "threads.events.list": (args) =>
          JSON.stringify(args.types) === '["item/completed"]'
            ? [
                { seq: 9, data: { item: { type: "commandExecution", command: "ls" } } },
                { seq: 8, data: { item: { type: "agentMessage", text: "sub-agent", parentToolCallId: "t1" } } },
                { seq: 7, data: { item: { type: "agentMessage", text: "Did it.\nblocked: needs a key" } } },
              ]
            : [],
      },
      calls,
    ).latestReply("thr_kid");
    expect(reply).toBe("Did it.\nblocked: needs a key");
    expect(calls.filter((call) => call.path === "threads.events.list").every((call) => call.args.order === "desc" && Number(call.args.limit) <= 100)).toBe(true);
  });

  it("reads FirstMate's board while firstmate-crew is degraded", async () => {
    const read = await ports({ "plugins.list": () => ({ plugins: [{ id: "firstmate-crew", enabled: true, status: "degraded" }] }) }).fleet();
    expect(read.ok).toBe(true);
    const crashed = await ports({ "plugins.list": () => ({ plugins: [{ id: "firstmate-crew", enabled: true, status: "crashed" }] }) }).fleet();
    expect(crashed).toEqual({ ok: false, reason: "FirstMate Crew is crashed." });
  });

  it("keeps each root thread once across pages, and says when the cap cut the list", async () => {
    const page = (offset: number, size: number) => Array.from({ length: size }, (_, index) => listRow(`thr_${offset + index}`));
    // A thread that moved between two reads shows up on both pages.
    const moved = await ports({ "threads.list": (args) => (args.offset === 0 ? page(0, 200) : [listRow("thr_199"), ...page(200, 5)]) }).rootThreads();
    expect(moved.threads).toHaveLength(205);
    expect(new Set(moved.threads.map((row) => row.id)).size).toBe(205);
    expect(moved.complete).toBe(true);
    const capped = await ports({ "threads.list": (args) => page(Number(args.offset), 200) }).rootThreads();
    expect(capped.complete).toBe(false);
    expect(capped.threads).toHaveLength(1_000);
  });
});

describe("isMissingFile", () => {
  it("knows bb's ways of saying a file is not there", () => {
    expect(isMissingFile(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(isMissingFile(new Error("ENOENT: no such file or directory"))).toBe(true);
    expect(isMissingFile(new Error("host is offline"))).toBe(false);
  });
});
