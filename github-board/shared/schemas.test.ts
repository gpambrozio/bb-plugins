import { describe, expect, it } from "vitest";

import { launchSeedsFor } from "./schemas";

describe("launchSeedsFor", () => {
  const launch = {
    projectId: "p1",
    providerId: "claude",
    model: "opus",
    reasoningLevel: "high",
    permissionMode: "auto",
    environment: { type: "host", hostId: "h", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "dev" } } },
  };

  it("keeps the environment in the project it was chosen in", () => {
    expect(launchSeedsFor(launch, "p1")).toEqual(launch);
  });

  it("drops it for any other project, keeping the model", () => {
    const { environment: _environment, ...rest } = launch;
    expect(launchSeedsFor(launch, "p2")).toEqual(rest);
    expect(launchSeedsFor(launch, null)).toEqual(rest);
  });
});
