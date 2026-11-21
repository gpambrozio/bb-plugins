import { describe, expect, it } from "vitest";

import { FleetSchema, bucketOf, groupFleet } from "./firstmate";
import { card } from "./testing/fake-ports";

const crew = (patch: { status?: string; pendingInteractions?: number } = {}) => ({ threadId: "thr_w", status: "idle", pendingInteractions: 0, ...patch });

describe("bucketOf", () => {
  it("puts holds and captain's calls under needs you, with the hold as the reason", () => {
    expect(bucketOf(card("Pick a name", { backlog: { hold: "Which of the three names? See https://x" } }))).toEqual({ bucket: "needsOwner", detail: "Which of the three names?" });
    expect(bucketOf(card("Approve the plan", { backlog: { kind: "captain" } }))).toEqual({ bucket: "needsOwner", detail: null });
  });

  it("calls a task blocked when it waits on another or its worker is stuck", () => {
    expect(bucketOf(card("Second step", { backlog: { blockedBy: "first-step" } })).bucket).toBe("blocked");
    expect(bucketOf(card("A", { backlog: { section: "in-flight" }, crew: crew(), report: { state: "needs-decision", text: "needs-decision: x?" } }))).toEqual({
      bucket: "blocked",
      detail: "worker needs a decision",
    });
    expect(bucketOf(card("B", { crew: crew(), report: { state: "blocked", text: "blocked: y" } })).detail).toBe("worker is blocked");
    expect(bucketOf(card("C", { crew: crew({ pendingInteractions: 1 }) })).detail).toBe("worker is waiting for an answer");
    expect(bucketOf(card("D", { crew: crew({ status: "error" }), column: "failed" })).detail).toBe("worker failed");
  });

  it("puts a working or finished-but-not-landed worker in flight, and the rest by section", () => {
    expect(bucketOf(card("W", { backlog: { section: "in-flight" }, crew: crew({ status: "active" }), column: "working" })).bucket).toBe("inFlight");
    expect(bucketOf(card("R", { crew: crew(), report: { state: "done", text: "done: PR" } })).bucket).toBe("inFlight");
    expect(bucketOf(card("I", { backlog: { section: "in-flight" } })).bucket).toBe("inFlight");
    expect(bucketOf(card("Q")).bucket).toBe("queued");
    expect(bucketOf(card("Old", { backlog: { section: "done", hold: "was held" } })).bucket).toBe("done");
    expect(bucketOf(card("Someday", { backlog: { section: "someday" } })).bucket).toBe("queued");
  });
});

describe("groupFleet", () => {
  it("groups the board and keeps done newest first, with plain titles and suggestions", () => {
    const fleet = FleetSchema.parse({
      home: "/h",
      mate: { threadId: "thr_mate", status: "idle", title: "FirstMate" },
      cards: [
        card("Held `thing`", { backlog: { hold: "yes or no?" } }),
        card("Working", { backlog: { section: "in-flight" }, crew: crew({ status: "active" }) }),
        card("Queued one"),
        card("Newest done", { backlog: { section: "done" } }),
        card("Older done", { backlog: { section: "done" } }),
      ],
      suggestions: [{ label: "Review **#12**", prompt: "Please review https://x" }],
      watches: [],
    });
    expect(groupFleet(fleet)).toEqual({
      threadId: "thr_mate",
      needsOwner: [{ title: "Held thing", detail: "yes or no?" }],
      blocked: [],
      inFlight: [{ title: "Working", detail: null }],
      queued: [{ title: "Queued one", detail: null }],
      done: [
        { title: "Newest done", detail: null },
        { title: "Older done", detail: null },
      ],
      suggestions: ["Review #12"],
    });
  });

  it("is null without a first mate", () => {
    expect(groupFleet({ mate: null, cards: [], suggestions: [] })).toBeNull();
  });
});
