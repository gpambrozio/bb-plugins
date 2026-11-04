import { describe, expect, it } from "vitest";

import { subjectKey } from "../shared/skills";
import { placeOf, showsSkills, subjectOf } from "./subject";

const worktree = { type: "managed-worktree", baseBranch: { kind: "default" } } as const;

describe("showsSkills", () => {
  it("shows in a thread's composer and the new-thread composer only", () => {
    expect(showsSkills({ kind: "thread", threadId: "thr_a" })).toBe(true);
    expect(showsSkills({ kind: "new-thread", projectId: null })).toBe(true);
    expect(showsSkills({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "msg_a" })).toBe(false);
  });
});

describe("placeOf", () => {
  it("names the environment a new thread would reuse", () => {
    expect(placeOf({ type: "reuse", environmentId: "env_a" })).toEqual({ hostId: null, environmentId: "env_a" });
  });

  it("names the machine it would run on", () => {
    expect(placeOf({ type: "host", hostId: "host_a", workspace: worktree })).toEqual({ hostId: "host_a", environmentId: null });
    expect(
      placeOf({
        type: "provider",
        environmentProviderId: "cloud",
        inputs: null,
        machine: { type: "existing", hostId: "host_b" },
      }),
    ).toEqual({ hostId: "host_b", environmentId: null });
  });

  it("names neither when the selection does not", () => {
    for (const environment of [
      undefined,
      { type: "project-default" },
      { type: "host", workspace: worktree },
      { type: "provider", environmentProviderId: "cloud", inputs: null },
      { type: "provider", environmentProviderId: "cloud", inputs: null, machine: { type: "new", machineProviderId: "vm", inputs: null } },
    ] as const) {
      expect(placeOf(environment)).toEqual({ hostId: null, environmentId: null });
    }
  });
});

describe("subjectOf", () => {
  it("is the thread in a thread's composer", () => {
    expect(subjectOf({ kind: "thread", threadId: "thr_a" }, null)).toEqual({ threadId: "thr_a" });
  });

  it("is the scope's project with the selected provider and place in the new-thread composer", () => {
    expect(
      subjectOf(
        { kind: "new-thread", projectId: "proj_a" },
        { projectId: "proj_a", providerId: "codex", environment: { type: "host", hostId: "host_a", workspace: worktree } },
      ),
    ).toEqual({ newThread: { projectId: "proj_a", providerId: "codex", hostId: "host_a", environmentId: null } });
  });

  it("is nothing yet while the project or the provider is unresolved", () => {
    expect(subjectOf({ kind: "new-thread", projectId: null }, { providerId: "codex" })).toBeNull();
    expect(subjectOf({ kind: "new-thread", projectId: "proj_a" }, { projectId: "proj_a" })).toBeNull();
    expect(subjectOf({ kind: "new-thread", projectId: "proj_a" }, null)).toBeNull();
    expect(subjectOf({ kind: "queued-message", threadId: "thr_a", queuedMessageId: "msg_a" }, null)).toBeNull();
  });
});

describe("subjectKey", () => {
  it("changes with the project, the provider, the machine and the environment", () => {
    const base = { projectId: "proj_a", providerId: "codex", hostId: null, environmentId: null };
    const keys = [
      { threadId: "proj_a" },
      { newThread: base },
      { newThread: { ...base, projectId: "proj_b" } },
      { newThread: { ...base, providerId: "claude-code" } },
      { newThread: { ...base, hostId: "host_a" } },
      { newThread: { ...base, environmentId: "env_a" } },
    ].map(subjectKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
