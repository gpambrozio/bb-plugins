import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { bbThreads } from "./bb-ports";

const SERVER_HOST = "host_server";

function source(hostId: string, isDefault: boolean) {
  return { hostId, isDefault, path: `/checkouts/${hostId}`, type: "local_path" };
}

function fakeSdk(sources: ReturnType<typeof source>[] = []) {
  return createFakeSdk({
    pluginId: "firstmate",
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
});
