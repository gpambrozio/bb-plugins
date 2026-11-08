import { describe, expect, it } from "vitest";

import { memoryOrientationStore } from "./testing/store";
import type { OrientationSummary } from "../shared/orientation";

type CreateInput = Parameters<ReturnType<typeof memoryOrientationStore>["orientations"]["create"]>[0];

function input(id: string, projectKey = "k", overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    id,
    projectKey,
    projectId: "proj_1",
    depth: "walkthrough",
    sourceThreadId: "thr_src",
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/work",
    providerId: "claude-code",
    headSha: "abc123",
    title: "Repo Orientation: demo",
    createdAt: 1,
    ...overrides,
  };
}

const listing = (n: number) => ({ caption: `c${n}`, path: "src/a.ts", startLine: 1, endLine: 3, text: "a\nb\nc", sha256: "h".repeat(8), ref: "abc123" });

describe("OrientationStore", () => {
  it("create starts a row and refuses a second live row for the project until the first ends", () => {
    const { orientations } = memoryOrientationStore();
    expect(orientations.create(input("ori_1"))).toMatchObject({ id: "ori_1", status: "starting", builderThreadId: null, summary: null, reminded: false, error: null, readyAt: null });
    expect(() => orientations.create(input("ori_2"))).toThrow(/UNIQUE/);
    expect(orientations.create(input("ori_other", "other")).status).toBe("starting");
    expect(orientations.transition("ori_1", ["starting", "building"], "failed", 5, "boom")).toBe(true);
    expect(orientations.get("ori_1")).toMatchObject({ status: "failed", error: "boom", updatedAt: 5 });
    expect(orientations.create(input("ori_2")).id).toBe("ori_2");
    expect(orientations.live("k")?.id).toBe("ori_2");
    expect(orientations.allLive().map((row) => row.id).sort()).toEqual(["ori_2", "ori_other"]);
  });

  it("bindBuilder binds once and byBuilder finds the row", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    expect(orientations.bindBuilder("ori_1", "thr_b", 2)).toBe(true);
    expect(orientations.bindBuilder("ori_1", "thr_other", 3)).toBe(false);
    expect(orientations.byBuilder("thr_b")?.id).toBe("ori_1");
    expect(orientations.get("ori_1")?.builderThreadId).toBe("thr_b");
    expect(orientations.byBuilder("thr_none")).toBeNull();
  });

  it("transition from the wrong status returns false and changes nothing", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    expect(orientations.transition("ori_1", ["building"], "ready", 9)).toBe(false);
    expect(orientations.get("ori_1")).toMatchObject({ status: "starting", updatedAt: 1, error: null });
    expect(orientations.transition("ori_1", ["starting"], "building", 9)).toBe(true);
    expect(orientations.get("ori_1")).toMatchObject({ status: "building", updatedAt: 9 });
  });

  it("stores the summary as JSON and the reminder once", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    const file = { path: "a.ts", does: "d", why: "w" };
    const concept = { name: "n", definition: "d", where: "a.ts" };
    const summary: OrientationSummary = {
      purpose: "p",
      languages: ["ts"],
      stages: ["s"],
      keyFiles: Array.from({ length: 6 }, () => file),
      concepts: Array.from({ length: 3 }, () => concept),
      gotchas: ["g", "h"],
      exercises: [
        { file: "a.ts", read: "r", question: "q" },
        { file: "b.ts", read: "r", question: "q" },
      ],
      sources: ["a.ts"],
    };
    orientations.setSummary("ori_1", summary, 4);
    expect(orientations.get("ori_1")?.summary).toEqual(summary);
    expect(orientations.markReminded("ori_1", 5)).toBe(true);
    expect(orientations.markReminded("ori_1", 6)).toBe(false);
    expect(orientations.get("ori_1")).toMatchObject({ reminded: true, updatedAt: 5 });
  });

  it("numbers listings 1, 2 and, after a pop, 3: a popped number is not reused", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    orientations.appendChapter("ori_1", "Intro", 2);
    expect(orientations.appendListing("ori_1", listing(1), 3)).toMatchObject({ kind: "listing", ordinal: 2, number: 1, check: null, sha256: "hhhhhhhh" });
    expect(orientations.appendListing("ori_1", listing(2), 4)).toMatchObject({ number: 2, ordinal: 3 });
    expect(orientations.pop("ori_1", 5)).toMatchObject({ kind: "listing", number: 2 });
    expect(orientations.appendListing("ori_1", listing(3), 6)).toMatchObject({ number: 3, ordinal: 4 });
    expect(orientations.appendNote("ori_1", "note", 7)).toMatchObject({ kind: "note", markdown: "note", ordinal: 5 });
    expect(orientations.counts("ori_1")).toEqual({ blocks: 4, listings: 2 });
    expect(orientations.blocks("ori_1").map((b) => b.ordinal)).toEqual([1, 2, 4, 5]);
    expect(orientations.blocks("ori_1")[0]).toMatchObject({ kind: "chapter", title: "Intro", orientationId: "ori_1" });
  });

  it("pop on an empty orientation returns null", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    expect(orientations.pop("ori_1", 2)).toBeNull();
  });

  it("setCheck records the last verification of a listing", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    const block = orientations.appendListing("ori_1", listing(1), 2);
    orientations.setCheck("ori_1", block.ordinal, { state: "moved", startLine: 5, endLine: 7 }, 10);
    expect(orientations.blocks("ori_1")[0]).toMatchObject({ check: { state: "moved", startLine: 5, endLine: 7, checkedAt: 10 } });
  });

  it("promoteReady leaves one ready row per project and deletes the old one's blocks", () => {
    const { orientations, db } = memoryOrientationStore();
    orientations.create(input("ori_old"));
    orientations.appendChapter("ori_old", "Old", 2);
    orientations.promoteReady("ori_old", 3);
    expect(orientations.ready("k")).toMatchObject({ id: "ori_old", status: "ready", readyAt: 3 });
    orientations.create(input("ori_other", "other"));
    orientations.promoteReady("ori_other", 3);
    orientations.create(input("ori_new", "k", { createdAt: 10 }));
    orientations.appendChapter("ori_new", "New", 11);
    orientations.promoteReady("ori_new", 12);
    expect(orientations.ready("k")?.id).toBe("ori_new");
    expect(orientations.get("ori_old")).toBeNull();
    expect(orientations.blocks("ori_old")).toEqual([]);
    expect(orientations.blocks("ori_new")).toHaveLength(1);
    expect(orientations.ready("other")?.id).toBe("ori_other");
    expect((db.prepare(`SELECT COUNT(*) AS n FROM orientations WHERE project_key = 'k' AND status = 'ready'`).get() as { n: number }).n).toBe(1);
  });

  it("purge removes only failed or cancelled rows older than the cutoff, with their blocks", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_f", "a", { createdAt: 1 }));
    orientations.appendChapter("ori_f", "x", 1);
    orientations.transition("ori_f", ["starting"], "failed", 10);
    orientations.create(input("ori_c", "b", { createdAt: 1 }));
    orientations.transition("ori_c", ["starting"], "cancelled", 20);
    orientations.create(input("ori_r", "c", { createdAt: 1 }));
    orientations.promoteReady("ori_r", 5);
    orientations.create(input("ori_live", "d", { createdAt: 1 }));
    orientations.create(input("ori_newf", "e", { createdAt: 1 }));
    orientations.transition("ori_newf", ["starting"], "failed", 100);
    expect(orientations.purge(50)).toBe(2);
    expect(["ori_f", "ori_c", "ori_r", "ori_live", "ori_newf"].map((id) => orientations.get(id) !== null)).toEqual([false, false, true, true, true]);
    expect(orientations.blocks("ori_f")).toEqual([]);
  });

  it("latestEnded answers the project's most recently ended failed or cancelled row", () => {
    const { orientations } = memoryOrientationStore();
    expect(orientations.latestEnded("k")).toBeNull();
    orientations.create(input("ori_f", "k", { createdAt: 1 }));
    orientations.transition("ori_f", ["starting"], "failed", 10, "boom");
    orientations.create(input("ori_c", "k", { createdAt: 11 }));
    orientations.transition("ori_c", ["starting"], "cancelled", 20, "Cancelled.");
    orientations.create(input("ori_r", "k", { createdAt: 21 }));
    orientations.promoteReady("ori_r", 30);
    orientations.create(input("ori_live", "k", { createdAt: 31 }));
    orientations.create(input("ori_other", "other", { createdAt: 40 }));
    orientations.transition("ori_other", ["starting"], "failed", 50);
    // Ready and live rows never count, nor another project's.
    expect(orientations.latestEnded("k")).toMatchObject({ id: "ori_c", status: "cancelled", error: "Cancelled." });
    orientations.transition("ori_live", ["starting"], "failed", 60, "late");
    expect(orientations.latestEnded("k")).toMatchObject({ id: "ori_live", error: "late" });
  });

  it("delete removes a row and its blocks", () => {
    const { orientations } = memoryOrientationStore();
    orientations.create(input("ori_1"));
    orientations.appendNote("ori_1", "n", 2);
    orientations.delete("ori_1");
    expect(orientations.get("ori_1")).toBeNull();
    expect(orientations.blocks("ori_1")).toEqual([]);
  });
});

describe("finishedSessionsFrom", () => {
  it("ignores a finished session whose trigger is orientation", () => {
    const { store, db } = memoryOrientationStore();
    const insert = db.prepare(
      `INSERT INTO sessions (id, mode, state, project_key, project_id, source_thread_id, topic, trigger, refs, brief_version, created_at, updated_at)
       VALUES (?, 'fork', 'finished', 'k', 'proj_1', 'thr_src', 't', ?, '{}', 'v', 1, 1)`,
    );
    insert.run("ses_a", "commit");
    insert.run("ses_b", "orientation");
    expect(store.finishedSessionsFrom("thr_src")).toBe(1);
  });
});
