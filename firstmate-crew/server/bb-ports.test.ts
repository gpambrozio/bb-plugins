import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { bbThreads } from "./bb-ports";
import { CompactFirstRefused } from "./ports";

const SERVER_HOST = "host_server";

function source(hostId: string, isDefault: boolean) {
  return { hostId, isDefault, path: `/checkouts/${hostId}`, type: "local_path" };
}

function fakeSdk(sources: ReturnType<typeof source>[] = []) {
  return createFakeSdk({
    pluginId: "firstmate-crew",
    overrides: {
      system: { config: () => ({ primaryHostId: SERVER_HOST }) },
      projects: { get: ({ projectId }) => ({ id: projectId, name: "web", sources }) },
      threads: { spawn: () => makeThreadResponse({ id: "thr_new" }) },
    },
  });
}

function spawnedEnvironment(harness: ReturnType<typeof fakeSdk>["harness"]): unknown {
  const [args] = harness.callsTo("threads.spawn")[0] as [{ environment: unknown }];
  return args.environment;
}

describe("bbThreads.spawn", () => {
  it("starts a thread in a plain directory on the bb server's own machine", async () => {
    const { sdk, harness } = fakeSdk();
    await bbThreads(sdk).spawn({ projectId: "proj_home", title: "First mate", prompt: "hi", environment: { kind: "path", path: "/home/fm" }, metadata: {} });
    expect(spawnedEnvironment(harness)).toEqual({ type: "host", hostId: SERVER_HOST, workspace: { type: "unmanaged", path: "/home/fm" } });
  });

  it("starts a worktree on the server's machine when the project has a checkout there", async () => {
    const { sdk, harness } = fakeSdk([source("host_other", true), source(SERVER_HOST, false)]);
    await bbThreads(sdk).spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: { kind: "worktree" }, metadata: {} });
    expect(spawnedEnvironment(harness)).toEqual({
      type: "host",
      hostId: SERVER_HOST,
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("starts a worktree on the machine of the project's default checkout when the server has none", async () => {
    const { sdk, harness } = fakeSdk([source("host_a", false), source("host_b", true)]);
    await bbThreads(sdk).spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: { kind: "worktree" }, metadata: {} });
    expect(spawnedEnvironment(harness)).toMatchObject({ type: "host", hostId: "host_b" });
  });

  it("names no machine when reusing an environment, which already has one", async () => {
    const { sdk, harness } = fakeSdk();
    await bbThreads(sdk).spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: { kind: "reuse", environmentId: "env_1" }, metadata: {} });
    expect(spawnedEnvironment(harness)).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("asks bb to create the thread pinned only when told to", async () => {
    const { sdk, harness } = fakeSdk();
    const threads = bbThreads(sdk);
    await threads.spawn({ projectId: "proj_home", title: "First mate", prompt: "hi", environment: { kind: "path", path: "/home/fm" }, metadata: {}, pinned: true });
    await threads.spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: { kind: "reuse", environmentId: "env_1" }, metadata: {} });
    const pinned = harness.callsTo("threads.spawn").map(([args]) => (args as { pinned?: boolean }).pinned);
    expect(pinned).toEqual([true, undefined]);
  });

  it("passes any reasoning level through for bb to check against the model", async () => {
    const { sdk, harness } = fakeSdk();
    const threads = bbThreads(sdk);
    for (const reasoningLevel of ["minimal", "high", ""]) {
      await threads.spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: { kind: "reuse", environmentId: "env_1" }, reasoningLevel, metadata: {} });
    }
    const levels = harness.callsTo("threads.spawn").map(([args]) => (args as { reasoningLevel?: string }).reasoningLevel);
    expect(levels).toEqual(["minimal", "high", undefined]);
  });

  it("passes the agent options through, and none when there are none", async () => {
    const { sdk, harness } = fakeSdk();
    const threads = bbThreads(sdk);
    const reuse = { kind: "reuse", environmentId: "env_1" } as const;
    await threads.spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: reuse, sessionOptions: { speed: "fast", web: true }, metadata: {} });
    await threads.spawn({ projectId: "proj_web", title: "t", prompt: "p", environment: reuse, metadata: {} });
    const options = harness.callsTo("threads.spawn").map(([args]) => (args as { sessionOptions?: unknown }).sessionOptions);
    expect(options).toEqual([{ speed: "fast", web: true }, undefined]);
  });
});

describe("bbThreads.send", () => {
  it("asks bb to compact first, queued as queue-if-active, for compact-first, and passes other modes as they are", async () => {
    const { sdk, harness } = createFakeSdk({ pluginId: "firstmate-crew", overrides: { threads: { send: () => ({ delivery: "sent" }) } } });
    const threads = bbThreads(sdk);
    await threads.send("thr_1", "hi", "compact-first");
    await threads.send("thr_1", "hi", "steer");
    const sent = harness.callsTo("threads.send").map(([args]) => {
      const { mode, compactFirst } = args as { mode: string; compactFirst?: boolean };
      return { mode, compactFirst };
    });
    expect(sent).toEqual([
      { mode: "queue-if-active", compactFirst: true },
      { mode: "steer", compactFirst: undefined },
    ]);
  });
});

describe("bbThreads.send refusals", () => {
  /** bb's client error: `HTTP <status>: <message>` with the status on it, as `BbHttpError` has. */
  function httpError(status: number, message: string): Error {
    return Object.assign(new Error(`HTTP ${status}: ${message}`), { name: "BbHttpError", status, code: "invalid_request" });
  }

  function failingSdk(error: unknown) {
    return createFakeSdk({
      pluginId: "firstmate-crew",
      overrides: {
        threads: {
          send: () => {
            throw error;
          },
        },
      },
    });
  }

  it.each([400, 409])("names a compact-first send bb answered with %i a refusal", async (status) => {
    const { sdk } = failingSdk(httpError(status, "Context can only be compacted while the thread is idle or errored"));
    const failure = await bbThreads(sdk).send("thr_1", "hi", "compact-first").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CompactFirstRefused);
    expect((failure as Error).message).toContain("Context can only be compacted");
  });

  it.each([
    ["a server error", httpError(500, "boom")],
    ["a lost connection", new TypeError("fetch failed")],
    ["a timeout", Object.assign(new Error("BB request timed out after 75 seconds."), { name: "BbRequestTimeoutError" })],
  ])("passes %s on as it is, since bb may have accepted the send", async (_what, error) => {
    const { sdk } = failingSdk(error);
    await expect(bbThreads(sdk).send("thr_1", "hi", "compact-first")).rejects.toBe(error);
  });

  it("never names a refusal for a send that did not ask to compact first", async () => {
    const error = httpError(409, "conflict");
    const { sdk } = failingSdk(error);
    await expect(bbThreads(sdk).send("thr_1", "hi", "auto")).rejects.toBe(error);
  });
});

describe("bbThreads.workspacePath", () => {
  function sdkWithEnvironment(environment: { hostId: string; path: string | null }) {
    return createFakeSdk({
      pluginId: "firstmate-crew",
      overrides: {
        system: { config: () => ({ primaryHostId: SERVER_HOST }) },
        environments: { get: ({ environmentId }) => ({ id: environmentId, ...environment }) },
      },
    });
  }

  it("is the environment's directory when it is on the bb server's machine", async () => {
    const { sdk } = sdkWithEnvironment({ hostId: SERVER_HOST, path: "/home/fm" });
    expect(await bbThreads(sdk).workspacePath("env_1")).toBe("/home/fm");
  });

  it("is null for an environment on another machine", async () => {
    const { sdk } = sdkWithEnvironment({ hostId: "host_other", path: "/home/fm" });
    expect(await bbThreads(sdk).workspacePath("env_1")).toBeNull();
  });
});

describe("bbThreads.origin", () => {
  function notFound(): Error {
    return Object.assign(new Error("not found"), { status: 404 });
  }

  // The getters are async, as the real SDK's requests are: a 404 arrives as a rejection, not a throw.
  function sdkWithThread(options: { environmentId?: string | null; projectGone?: boolean; threadGone?: boolean } = {}) {
    return createFakeSdk({
      pluginId: "firstmate-crew",
      overrides: {
        threads: {
          get: async ({ threadId }) => {
            if (options.threadGone) throw notFound();
            return makeThreadResponse({ id: threadId, projectId: "proj_web", environmentId: options.environmentId === undefined ? "env_1" : options.environmentId });
          },
        },
        projects: {
          get: async ({ projectId }) => {
            if (options.projectGone) throw notFound();
            return { id: projectId, name: "web", sources: [] };
          },
        },
        environments: { get: ({ environmentId }) => ({ id: environmentId, branchName: "fix/login-redirect" }) },
      },
    });
  }

  it("names the thread's project and its environment's branch", async () => {
    const { sdk } = sdkWithThread();
    expect(await bbThreads(sdk).origin("thr_1")).toEqual({ projectName: "web", branchName: "fix/login-redirect" });
  });

  it("has no branch for a thread without an environment, and no project name for a project bb no longer has", async () => {
    expect(await bbThreads(sdkWithThread({ environmentId: null }).sdk).origin("thr_1")).toEqual({ projectName: "web", branchName: null });
    expect(await bbThreads(sdkWithThread({ projectGone: true }).sdk).origin("thr_1")).toEqual({ projectName: null, branchName: "fix/login-redirect" });
  });

  it("is null for a thread bb does not have", async () => {
    expect(await bbThreads(sdkWithThread({ threadGone: true }).sdk).origin("thr_1")).toBeNull();
  });
});

describe("bbThreads.metadataOf", () => {
  function sdkWithMetadata(metadata: Record<string, Record<string, string>>) {
    return createFakeSdk({
      pluginId: "firstmate-crew",
      overrides: {
        threads: {
          experimental_listPluginMetadata: ({ threadIds }) => ({
            threads: threadIds.filter((threadId) => threadId in metadata).map((threadId) => ({ threadId, metadata: metadata[threadId]! })),
          }),
        },
      },
    });
  }

  it("reads every thread's metadata in one request, leaving out a thread with none", async () => {
    const { sdk, harness } = sdkWithMetadata({ thr_a: { task: "a" }, thr_c: { task: "c" } });
    const found = await bbThreads(sdk).metadataOf(["thr_a", "thr_b", "thr_c"]);
    expect(found).toEqual(new Map([["thr_a", { task: "a" }], ["thr_c", { task: "c" }]]));
    expect(harness.callsTo("threads.experimental_listPluginMetadata")).toEqual([[expect.objectContaining({ threadIds: ["thr_a", "thr_b", "thr_c"] })]]);
  });

  it("splits a crew larger than bb answers for at once into requests of 200, and sends none for no threads", async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `thr_${index}`);
    const { sdk, harness } = sdkWithMetadata({ thr_0: { task: "first" }, thr_449: { task: "last" } });
    const found = await bbThreads(sdk).metadataOf(ids);
    expect(found).toEqual(new Map([["thr_0", { task: "first" }], ["thr_449", { task: "last" }]]));
    const batches = harness.callsTo("threads.experimental_listPluginMetadata").map(([args]) => (args as { threadIds: string[] }).threadIds);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(ids);

    const empty = sdkWithMetadata({});
    expect(await bbThreads(empty.sdk).metadataOf([])).toEqual(new Map());
    expect(empty.harness.callsTo("threads.experimental_listPluginMetadata")).toEqual([]);
  });
});

describe("bbThreads, autocompact's reads", () => {
  it("reads a thread's rest state from its row and its pending interactions", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.get", () =>
      makeThreadResponse({
        id: "thr_1",
        status: "idle",
        parentThreadId: "thr_mate",
        runtime: { displayStatus: "waiting-for-host" },
        queuedMessageCount: 2,
        activeBackgroundAgentCount: 1,
      }),
    );
    harness.stub("threads.interactions.list", () => [{ status: "pending" }, { status: "resolved" }]);

    expect(await bbThreads(sdk).restState("thr_1")).toEqual({
      status: "idle",
      parentThreadId: "thr_mate",
      runtimeStatus: "waiting-for-host",
      queuedMessages: 2,
      pendingInteractions: 1,
      backgroundAgents: 1,
    });
  });

  it("has no rest state for an archived thread", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.get", () => makeThreadResponse({ id: "thr_1", archivedAt: 5 }));
    expect(await bbThreads(sdk).restState("thr_1")).toBeNull();
  });

  it("takes the end of the last turn from the newest turn/completed event", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.events.list", () => [{ seq: 42, createdAt: 1_700_000_000_000, type: "turn/completed" }]);

    expect(await bbThreads(sdk).lastTurnEnd("thr_1")).toEqual({ seq: 42, at: 1_700_000_000_000 });
    expect(harness.callsTo("threads.events.list")[0]).toEqual([{ threadId: "thr_1", types: ["turn/completed"], order: "desc", limit: "1" }]);
  });

  it("has no last turn for a thread that has never finished one", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.events.list", () => []);
    expect(await bbThreads(sdk).lastTurnEnd("thr_1")).toBeNull();
  });

  it("counts turn/started events after a sequence, no further than the limit", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.events.list", () => [{ seq: 43 }, { seq: 50 }]);

    expect(await bbThreads(sdk).turnsStartedAfter("thr_1", 42, 2)).toBe(2);
    expect(harness.callsTo("threads.events.list")[0]).toEqual([
      { threadId: "thr_1", types: ["turn/started"], afterSeq: "42", order: "asc", limit: "2" },
    ]);
  });

  it("reads context usage, and none when bb has no figure", async () => {
    const { sdk, harness } = fakeSdk();
    harness.stub("threads.context", () => ({ usage: { usedTokens: 250_000, estimated: true, modelContextWindow: 1_000_000 } }));
    expect(await bbThreads(sdk).contextUsage("thr_1")).toEqual({ usedTokens: 250_000, estimated: true, cacheExpiresAt: null });

    harness.stub("threads.context", () => ({ usage: null }));
    expect(await bbThreads(sdk).contextUsage("thr_1")).toBeNull();
  });

  it("reads when bb says the prompt cache expires, as epoch milliseconds", async () => {
    const { sdk, harness } = fakeSdk();
    const usage = { usedTokens: 250_000, estimated: false, modelContextWindow: 1_000_000, compactionOfferAt: "2026-10-28T12:00:00.000Z" };
    harness.stub("threads.context", () => ({ usage }));
    expect((await bbThreads(sdk).contextUsage("thr_1"))?.cacheExpiresAt).toBe(Date.UTC(2026, 9, 28, 12));
  });
});
