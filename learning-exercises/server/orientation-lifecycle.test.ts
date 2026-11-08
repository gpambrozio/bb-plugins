/**
 * The builder's lifecycle (spec §7): the idle reminder and then failure, a failed turn, the 30-minute cap
 * and the purge, reload safety (`reconcile`, failing closed), and that a disposed copy writes nothing.
 */
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { OrientationSummary } from "../shared/orientation";
import { ORIENTATION_METADATA_KEY, OrientationService } from "./orientation";
import type { OrientationStore } from "./orientation-store";
import { FakePorts, flush, thread } from "./testing/fake-ports";
import { memoryOrientationStore, settingsWith } from "./testing/store";

const SOURCE = "thr_src";
const BUILDER = "thr_spawn1";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RETRY = "/work/calc/src/retry.ts";
const RETRY_TEXT = "export function retry() {\n  return attempt();\n}\n";

const SUMMARY: OrientationSummary = {
  purpose: "A calculator.",
  languages: ["TypeScript"],
  stages: ["Parse", "Evaluate"],
  keyFiles: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `src/f${n}.ts`, does: "does", why: "why" })),
  concepts: [1, 2, 3].map((n) => ({ name: `c${n}`, definition: "d", where: "w" })),
  gotchas: ["g1", "g2"],
  exercises: [
    { file: "src/f1.ts", read: "the parser", question: "Why?" },
    { file: "src/f2.ts", read: "the evaluator", question: "How?" },
  ],
  sources: ["README.md"],
};

let unhandled = 0;
const countUnhandled = () => {
  unhandled += 1;
};
beforeAll(() => {
  process.on("unhandledRejection", countUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", countUnhandled);
});
afterEach(async () => {
  await flush();
  expect(unhandled).toBe(0);
});

/** Everything the store holds, to compare before and after an await. */
function snapshot(db: Database.Database): string {
  return JSON.stringify([
    db.prepare("SELECT * FROM orientations ORDER BY id").all(),
    db.prepare("SELECT * FROM orientation_blocks ORDER BY orientation_id, ordinal").all(),
  ]);
}

function service(ports: FakePorts, store: OrientationStore): OrientationService {
  return new OrientationService(ports, store, () => settingsWith());
}

/** A reconciled service over a fresh store. */
async function setup() {
  const ports = new FakePorts();
  ports.threads.set(SOURCE, thread({ id: SOURCE }));
  ports.files.set(RETRY, RETRY_TEXT);
  const { orientations, db } = memoryOrientationStore();
  const orient = service(ports, orientations);
  await orient.reconcile();
  return { ports, store: orientations, db, service: orient };
}

/** A summary-depth build bound to `BUILDER`. */
async function building() {
  const context = await setup();
  const { orientationId } = await context.service.start({ sourceThreadId: SOURCE, depth: "summary" });
  return { ...context, id: orientationId };
}

/** This plugin's unarchived threads with an orientation id that no live row has them building. */
function leftovers(ports: FakePorts, store: OrientationStore): string[] {
  const found: string[] = [];
  for (const [threadId, metadata] of ports.threadMetadata) {
    const value = metadata[ORIENTATION_METADATA_KEY];
    if (value === undefined || ports.threads.get(threadId)?.archivedAt !== null) continue;
    const row = store.get(value);
    const live = row !== null && (row.status === "starting" || row.status === "building") && row.builderThreadId === threadId;
    if (!live) found.push(threadId);
  }
  return found;
}

/** Replaces `ports[method]` so that its `nth` call disposes `target` before it answers, noting the store then. */
function disposeDuring(ports: FakePorts, method: keyof FakePorts, target: () => OrientationService, db: Database.Database, nth = 1) {
  const original = (ports[method] as (...args: unknown[]) => Promise<unknown>).bind(ports);
  let calls = 0;
  const state = { at: null as string | null };
  (ports as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    calls += 1;
    if (calls === nth) {
      target().dispose();
      state.at = snapshot(db);
    }
    return result;
  };
  return state;
}

describe("a builder that goes idle", () => {
  it("is reminded once with a visible line and an agent-only part, then failed, stopped and archived", async () => {
    const { ports, store, service, id } = await building();
    await service.onIdle(BUILDER);
    expect(ports.sends).toEqual([
      {
        threadId: BUILDER,
        visible: "Reminder: finish the orientation.",
        agentOnly: expect.stringContaining("orient_finish"),
      },
    ]);
    expect(store.get(id)).toMatchObject({ status: "building", reminded: true });
    expect(ports.stopped).toEqual([]);

    await service.onIdle(BUILDER);
    expect(ports.sends).toHaveLength(1);
    expect(store.get(id)).toMatchObject({ status: "failed", error: "The builder stopped before finishing." });
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
  });

  it("changes nothing on a ready row and puts its builder away, since finish leaves it running", async () => {
    const { ports, store, service, id } = await building();
    await service.summary(BUILDER, SUMMARY);
    await service.finish(BUILDER);
    const before = store.get(id);
    expect(before?.status).toBe("ready");
    expect(ports.archived).toEqual([]);
    ports.advance(MINUTE);
    await service.onIdle(BUILDER);
    expect(ports.sends).toEqual([]);
    expect(store.get(id)).toEqual(before);
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
    // Its next idle (bb may report one for the stop) finds it archived and does nothing more.
    await service.onIdle(BUILDER);
    expect(ports.archived).toEqual([BUILDER]);
  });

  it("ignores a thread that builds nothing", async () => {
    const { ports, service } = await building();
    await service.onIdle(SOURCE);
    await service.onFailed(SOURCE);
    expect(ports.sends).toEqual([]);
    expect(ports.stopped).toEqual([]);
    expect(service.isBuilderThread(BUILDER)).toBe(true);
    expect(service.isBuilderThread(SOURCE)).toBe(false);
  });
});

describe("bb's events never reject", () => {
  it("logs a store that throws instead of rejecting onIdle or onFailed", async () => {
    const { ports, store, service: orient } = await building();
    store.byBuilder = () => {
      throw new Error("database is closed");
    };
    await expect(orient.onIdle(BUILDER)).resolves.toBeUndefined();
    await expect(orient.onFailed(BUILDER)).resolves.toBeUndefined();
    expect(ports.warnings.filter((line) => line.includes("database is closed"))).toHaveLength(2);
  });
});

describe("a builder whose turn fails", () => {
  it("is failed at once, stopped and archived", async () => {
    const { ports, store, service, id } = await building();
    await service.onFailed(BUILDER);
    expect(store.get(id)).toMatchObject({ status: "failed", error: "The builder's turn failed." });
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
    expect(ports.sends).toEqual([]);
  });
});

describe("the sweep", () => {
  it("cancels a build older than 30 minutes and puts its builder away", async () => {
    const { ports, store, service, id } = await building();
    ports.advance(29 * MINUTE);
    await service.sweep();
    expect(store.get(id)?.status).toBe("building");
    expect(ports.archived).toEqual([]);
    ports.advance(2 * MINUTE);
    await service.sweep();
    expect(store.get(id)).toMatchObject({ status: "cancelled", error: "Took longer than 30 minutes." });
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
  });

  it("purges failed and cancelled rows last changed more than 7 days ago", async () => {
    const { ports, store, service } = await setup();
    const make = (id: string, status: "failed" | "cancelled", at: number) => {
      store.create({
        id,
        projectKey: `key_${id}`,
        projectId: "proj_1",
        depth: "summary",
        sourceThreadId: SOURCE,
        environmentId: "env_1",
        hostId: "host_1",
        workspacePath: "/work/calc",
        providerId: "claude-code",
        headSha: null,
        title: "Repo Orientation: calc",
        createdAt: at,
      });
      store.transition(id, ["starting"], status, at, "x");
    };
    make("ori_old", "failed", ports.now() - 8 * DAY);
    make("ori_oldc", "cancelled", ports.now() - 8 * DAY);
    make("ori_recent", "failed", ports.now() - 6 * DAY);
    await service.sweep();
    expect(store.get("ori_old")).toBeNull();
    expect(store.get("ori_oldc")).toBeNull();
    expect(store.get("ori_recent")?.status).toBe("failed");
  });
});

describe("reload safety", () => {
  it("keeps a building row whose builder is working, and fails one whose builder is gone, idle with no turn, or errored", async () => {
    const { ports, store, service: first, id } = await building();
    ports.threads.set(BUILDER, { ...ports.threads.get(BUILDER)!, status: "active" });
    const second = service(ports, store);
    await second.reconcile();
    expect(second.clean).toBe(true);
    expect(store.get(id)?.status).toBe("building");
    expect(ports.archived).toEqual([]);

    // Idle after a turn: between turns, its idle handled by whichever copy heard it.
    ports.threads.set(BUILDER, { ...ports.threads.get(BUILDER)!, status: "idle" });
    ports.running.set(BUILDER, "turn_1");
    await service(ports, store).reconcile();
    expect(store.get(id)?.status).toBe("building");

    ports.threads.set(BUILDER, { ...ports.threads.get(BUILDER)!, status: "error" });
    const third = service(ports, store);
    await third.reconcile();
    expect(third.clean).toBe(true);
    expect(store.get(id)).toMatchObject({ status: "failed", error: "Interrupted by a reload." });
    expect(ports.stopped).toEqual([BUILDER]);
    expect(ports.archived).toEqual([BUILDER]);
    first.dispose();
  });

  it("fails a row whose builder thread is gone or archived without putting it away again, and stays clean", async () => {
    for (const change of ["gone", "archived"] as const) {
      const { ports, store, id } = await building();
      if (change === "gone") ports.threads.delete(BUILDER);
      else ports.threads.set(BUILDER, { ...ports.threads.get(BUILDER)!, status: "active", archivedAt: 5 });
      // As bb would: a deleted thread cannot be stopped or archived.
      const archive = ports.archiveThread.bind(ports);
      ports.archiveThread = async (threadId) => {
        if (!ports.threads.has(threadId)) throw new Error("thread not found");
        await archive(threadId);
      };
      const next = service(ports, store);
      await next.reconcile();
      expect(store.get(id)).toMatchObject({ status: "failed", error: "Interrupted by a reload." });
      expect(ports.stopped).toEqual([]);
      expect(ports.archived).toEqual([]);
      expect(next.clean).toBe(true);
    }
  });

  it("archives this plugin's threads with an orientation id that is not live, and never one already archived", async () => {
    const { ports, store, service: orient } = await setup();
    const leftover = (id: string, value: string, archivedAt: number | null) => {
      ports.threads.set(id, thread({ id, originPluginId: "learning-exercises", visibility: "hidden", archivedAt }));
      ports.threadMetadata.set(id, { [ORIENTATION_METADATA_KEY]: value });
    };
    leftover("thr_unknown", "ori_nothing", null);
    leftover("thr_old", "ori_gone", 5);
    // Another plugin's thread with the same key is not ours to archive.
    ports.threads.set("thr_theirs", thread({ id: "thr_theirs", originPluginId: "other-plugin" }));
    ports.threadMetadata.set("thr_theirs", { [ORIENTATION_METADATA_KEY]: "ori_nothing" });
    await orient.reconcile();
    expect(ports.archived).toEqual(["thr_unknown"]);
    expect(orient.clean).toBe(true);
  });

  it("stays unclean while this plugin's threads cannot be listed, and a sweep cleans up once they can", async () => {
    const ports = new FakePorts();
    ports.threads.set(SOURCE, thread({ id: SOURCE }));
    const { orientations } = memoryOrientationStore();
    const orient = service(ports, orientations);
    ports.pluginThreadsUnreadable = true;
    await orient.reconcile();
    expect(orient.clean).toBe(false);
    expect(ports.warnings.length).toBeGreaterThan(0);
    await expect(orient.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("Cleaning up an earlier build; try again shortly.");
    await orient.sweep();
    expect(orient.clean).toBe(false);
    ports.pluginThreadsUnreadable = false;
    await orient.sweep();
    expect(orient.clean).toBe(true);
    await orient.start({ sourceThreadId: SOURCE, depth: "summary" });
    expect(ports.spawned).toHaveLength(1);
  });

  it("stays unclean while an archive fails, and archives on a later sweep", async () => {
    const { ports, store } = await setup();
    ports.threads.set("thr_left", thread({ id: "thr_left", originPluginId: "learning-exercises", visibility: "hidden" }));
    ports.threadMetadata.set("thr_left", { [ORIENTATION_METADATA_KEY]: "ori_nothing" });
    ports.archiveFails = true;
    const orient = service(ports, store);
    await orient.reconcile();
    expect(orient.clean).toBe(false);
    expect(ports.warnings.some((line) => line.includes("thr_left"))).toBe(true);
    await orient.sweep();
    expect(orient.clean).toBe(false);
    ports.archiveFails = false;
    await orient.sweep();
    expect(orient.clean).toBe(true);
    expect(ports.archived).toEqual(["thr_left"]);
  });

  describe("a reload while the spawn is on its way (Review Focus 3)", () => {
    async function reload(hook: "beforeSpawn" | "duringSpawn", working: boolean) {
      const { ports, store, db, service: a } = await setup();
      let b: OrientationService | null = null;
      let afterReconcile = "";
      const reloadNow = async () => {
        a.dispose();
        b = service(ports, store);
        await b.reconcile();
        afterReconcile = snapshot(db);
      };
      if (hook === "beforeSpawn") ports.beforeSpawn = reloadNow;
      else
        ports.duringSpawn = async (threadId) => {
          if (working) ports.threads.set(threadId, { ...ports.threads.get(threadId)!, status: "active" });
          await reloadNow();
        };
      await expect(a.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("reloaded");
      ports.beforeSpawn = null;
      ports.duringSpawn = null;
      // A wrote nothing once the spawn answered.
      expect(snapshot(db)).toBe(afterReconcile);
      const next = b as unknown as OrientationService;
      await next.sweep();
      const rows = db.prepare("SELECT id, status FROM orientations").all() as { id: string; status: string }[];
      expect(rows).toHaveLength(1);
      expect(store.allLive().length).toBeLessThanOrEqual(1);
      expect(leftovers(ports, store)).toEqual([]);
      return { ports, store, next, row: rows[0]! };
    }

    it("binds a builder that is already working when the new copy reconciles", async () => {
      const { store, next, row } = await reload("duringSpawn", true);
      expect(row.status).toBe("building");
      expect(store.get(row.id)?.builderThreadId).toBe(BUILDER);
      expect(next.clean).toBe(true);
      expect(next.isBuilderThread(BUILDER)).toBe(true);
    });

    it("fails the row and archives a thread that has not run a turn", async () => {
      const { ports, store, next, row } = await reload("duringSpawn", false);
      expect(row.status).toBe("failed");
      expect(store.get(row.id)?.error).toBe("Interrupted by a reload.");
      expect(ports.archived).toEqual([BUILDER]);
      expect(next.clean).toBe(true);
      await next.start({ sourceThreadId: SOURCE, depth: "summary" });
      expect(store.allLive()).toHaveLength(1);
    });

    it("fails a row with no thread yet, stays unclean, and archives the thread that turns up on the next sweep", async () => {
      const { ports, store, db, service: a } = await setup();
      let b: OrientationService | null = null;
      ports.beforeSpawn = async () => {
        a.dispose();
        b = service(ports, store);
        await b.reconcile();
      };
      await expect(a.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("reloaded");
      const next = b as unknown as OrientationService;
      const [row] = db.prepare("SELECT id, status, error FROM orientations").all() as { id: string; status: string; error: string }[];
      expect(row).toMatchObject({ status: "failed", error: "Interrupted by a reload." });
      expect(next.clean).toBe(false);
      expect(leftovers(ports, store)).toEqual([BUILDER]);
      await next.sweep();
      expect(next.clean).toBe(true);
      expect(ports.archived).toEqual([BUILDER]);
      expect(leftovers(ports, store)).toEqual([]);
      expect(store.allLive()).toEqual([]);
    });

    /** A reload mid-spawn whose thread bb makes only after the new copy's next sweep has made it clean. */
    async function lateThread() {
      const { ports, store, db, service: a } = await setup();
      let b: OrientationService | null = null;
      ports.beforeSpawn = async () => {
        a.dispose();
        b = service(ports, store);
        await b.reconcile();
        await b.sweep();
      };
      await expect(a.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("reloaded");
      ports.beforeSpawn = null;
      const next = b as unknown as OrientationService;
      expect(next.clean).toBe(true);
      expect(leftovers(ports, store)).toEqual([BUILDER]);
      return { ports, store, db, next };
    }

    it("puts away a thread bb made after the sweep on its first tool call", async () => {
      const { ports, store, next } = await lateThread();
      await expect(next.summary(BUILDER, SUMMARY)).rejects.toThrow("This thread is not building an orientation.");
      await flush();
      expect(ports.stopped).toEqual([BUILDER]);
      expect(ports.archived).toEqual([BUILDER]);
      expect(leftovers(ports, store)).toEqual([]);
      expect(store.allLive()).toEqual([]);
    });

    it("puts away a thread bb made after the sweep on its first idle, or its first failed turn", async () => {
      for (const event of ["onIdle", "onFailed"] as const) {
        const { ports, store, next } = await lateThread();
        await next[event](BUILDER);
        expect(ports.stopped).toEqual([BUILDER]);
        expect(ports.archived).toEqual([BUILDER]);
        expect(leftovers(ports, store)).toEqual([]);
        expect(ports.sends).toEqual([]);
      }
    });

    it("leaves alone an unbound thread whose row is still starting, and another plugin's thread", async () => {
      const { ports, store, service: orient } = await setup();
      ports.duringSpawn = async (threadId) => {
        await orient.onIdle(threadId);
        await expect(orient.builderFor("thr_theirs")).rejects.toThrow("This thread is not building an orientation.");
      };
      ports.threads.set("thr_theirs", thread({ id: "thr_theirs", originPluginId: "other-plugin" }));
      ports.threadMetadata.set("thr_theirs", { [ORIENTATION_METADATA_KEY]: "ori_nothing" });
      await orient.onIdle("thr_theirs");
      await orient.start({ sourceThreadId: SOURCE, depth: "summary" });
      await flush();
      expect(ports.stopped).toEqual([]);
      expect(ports.archived).toEqual([]);
      expect(store.allLive()[0]).toMatchObject({ status: "building", builderThreadId: BUILDER });
    });

    it("leaves at most one live row and no unowned thread whichever way it goes", async () => {
      for (const [hook, working] of [
        ["beforeSpawn", false],
        ["duringSpawn", false],
        ["duringSpawn", true],
      ] as const) {
        const { store, ports } = await reload(hook, working);
        expect(store.allLive().length).toBeLessThanOrEqual(1);
        expect(leftovers(ports, store)).toEqual([]);
      }
    });
  });
});

describe("a disposed copy writes nothing", () => {
  it.each(["thread", "project", "environmentRoot", "headSha", "spawn"] as const)("start: disposed during %s", async (method) => {
    const { ports, db, service: orient } = await setup();
    const state = disposeDuring(ports, method, () => orient, db);
    await expect(orient.start({ sourceThreadId: SOURCE, depth: "summary" })).rejects.toThrow("reloaded");
    expect(state.at).not.toBeNull();
    expect(snapshot(db)).toBe(state.at);
  });

  it.each(["environmentRoot", "readFile"] as const)("listing: disposed during %s", async (method) => {
    const { ports, db, service: orient } = await setup();
    await orient.start({ sourceThreadId: SOURCE, depth: "walkthrough" });
    const state = disposeDuring(ports, method, () => orient, db);
    await expect(orient.listing(BUILDER, { path: "src/retry.ts", lines: "1-2", caption: "Retry" })).rejects.toThrow("reloaded");
    expect(state.at).not.toBeNull();
    expect(snapshot(db)).toBe(state.at);
  });

  it.each(["environmentRoot", "readFile"] as const)("finish and verify: disposed during %s", async (method) => {
    for (const action of ["finish", "verify"] as const) {
      const { ports, db, service: orient } = await setup();
      const { orientationId } = await orient.start({ sourceThreadId: SOURCE, depth: "walkthrough" });
      await orient.chapter(BUILDER, "Retries");
      await orient.listing(BUILDER, { path: "src/retry.ts", lines: "1-2", caption: "Retry" });
      await orient.note(BUILDER, "Listing 1 retries.");
      await orient.summary(BUILDER, SUMMARY);
      const state = disposeDuring(ports, method, () => orient, db);
      const run = action === "finish" ? orient.finish(BUILDER) : orient.verify(orientationId);
      await expect(run).rejects.toThrow("reloaded");
      expect(state.at).not.toBeNull();
      expect(snapshot(db)).toBe(state.at);
    }
  });

  it.each(["pluginThreadsWith", "thread", "currentTurn", "stopThread", "archiveThread"] as const)("reconcile: disposed during %s", async (method) => {
    const { ports, store, db } = await building();
    // Idle after a turn would be kept; idle with none is failed, so every await of a reconcile is reached.
    ports.threads.set("thr_left", thread({ id: "thr_left", originPluginId: "learning-exercises", visibility: "hidden" }));
    ports.threadMetadata.set("thr_left", { [ORIENTATION_METADATA_KEY]: "ori_nothing" });
    const next = service(ports, store);
    const state = disposeDuring(ports, method, () => next, db);
    await next.reconcile();
    expect(state.at).not.toBeNull();
    expect(snapshot(db)).toBe(state.at);
    expect(next.clean).toBe(false);
  });
});

