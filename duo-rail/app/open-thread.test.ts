import { describe, expect, it } from "vitest";

import { openThreadTarget, type OpenThreadSource } from "./open-thread";

const thread: OpenThreadSource = {
  id: "t1",
  projectId: "p1",
  parentThreadId: null,
  parentNotifications: "all" as never,
  archivedAt: null,
  pinnedAt: 5,
  sectionId: "s1",
  isUnread: true,
  status: "idle" as never,
  environment: { id: "env1", path: "/work/acme" } as never,
};

describe("openThreadTarget", () => {
  it("makes the open thread a thread action's target", () => {
    expect(openThreadTarget([thread], "t1")).toEqual({
      id: "t1",
      projectId: "p1",
      parentThreadId: null,
      parentNotifications: "all",
      archivedAt: null,
      pinnedAt: 5,
      sectionId: "s1",
      isUnread: true,
      status: "idle",
      environment: { id: "env1", path: "/work/acme" },
    });
  });

  it("has no target without an open thread, or for one bb's list does not have", () => {
    expect(openThreadTarget([thread], null)).toBeNull();
    expect(openThreadTarget([thread], "t2")).toBeNull();
  });

  it("gives a thread with no environment none", () => {
    expect(openThreadTarget([{ ...thread, environment: { id: null, path: null } as never }], "t1")?.environment).toBeNull();
  });
});
