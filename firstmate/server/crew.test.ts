import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREW_METADATA } from "../shared/types";
import { endCrew, interruptCrew, noteCrew, relaunchCrew, steerCrew } from "./crew";
import { ReportCache, type FleetDeps } from "./fleet";
import type { FirstmateSettings } from "./settings";
import { fakeLog, fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

// The wording is the templates' (charter.test.ts reads it); these tests pin the values they are filled from.
vi.mock("./templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./templates")>();
  return {
    ...actual,
    message: async (path: string, values: Record<string, string> = {}) => `${path} ${JSON.stringify(values)}`,
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(backlog = "") {
  const home = await mkdtemp(join(tmpdir(), "firstmate-crew-"));
  tempDirs.push(home);
  await mkdir(join(home, "data"), { recursive: true });
  if (backlog !== "") await writeFile(join(home, "data", "backlog.md"), backlog, "utf8");
  const threads = fakeThreads();
  const store = memoryStore();
  const settings: FirstmateSettings = { homeDirectory: home, crewProvider: "", crewModel: "", crewReasoning: "default", refreshSeconds: 10 };
  const deps: FleetDeps = {
    threads,
    projects: fakeProjects(),
    store,
    settings: async () => settings,
    reports: new ReportCache(threads),
    watches: async () => [],
    log: fakeLog(),
  };
  const mate = threads.add({ id: "thr_mate", title: "First mate" });
  await store.setMateThreadId(mate.id);
  const worker = threads.add({ id: "thr_w", title: "Fix login", parentThreadId: mate.id, environmentId: "env_w" });
  threads.setMetadata(worker.id, { [CREW_METADATA.task]: "fix-login" });
  return { deps, threads, store, mate, worker };
}

/** The values a mocked `message` was filled with, from the text it returned. */
function valuesOf(text: string | undefined, path: string): Record<string, string> {
  expect(text?.startsWith(`${path} `)).toBe(true);
  return JSON.parse((text ?? "").slice(path.length + 1)) as Record<string, string>;
}

describe("crew actions", () => {
  it("steers with mode steer", async () => {
    const { deps, threads } = await setup();
    await steerCrew(deps, "thr_w", "use the other API");
    expect(threads.sent).toEqual([{ id: "thr_w", text: "use the other API", mode: "steer" }]);
  });

  it("interrupts by stopping the thread", async () => {
    const { deps, threads } = await setup();
    threads.setStatus("thr_w", "active");
    await interruptCrew(deps, "thr_w");
    expect(threads.callsTo("stop")).toEqual([["thr_w"]]);
  });

  describe("endCrew", () => {
    const inFlight = "## In flight\n- [ ] fix-login - Fix the login\n";

    it("asks first when the item is not Done, and archives nothing", async () => {
      const { deps, threads } = await setup(inFlight);
      expect(await endCrew(deps, "thr_w", false)).toEqual({ ended: false, needsConfirmation: true });
      expect(threads.callsTo("archive")).toEqual([]);
    });

    it("archives a not-Done item once confirmed", async () => {
      const { deps, threads } = await setup(inFlight);
      expect(await endCrew(deps, "thr_w", true)).toEqual({ ended: true, needsConfirmation: false });
      expect(threads.callsTo("archive")).toEqual([["thr_w"]]);
    });

    it("archives without asking when the joined item is Done, found by task or by thread", async () => {
      const byTask = await setup("## Done\n- [x] fix-login - Fix the login (merged 2026-09-01)\n");
      expect(await endCrew(byTask.deps, "thr_w", false)).toEqual({ ended: true, needsConfirmation: false });
      expect(byTask.threads.callsTo("archive")).toEqual([["thr_w"]]);

      const byThread = await setup("## Done\n- [x] other - Something (thread: thr_w) (merged 2026-09-01)\n");
      expect(await endCrew(byThread.deps, "thr_w", false)).toEqual({ ended: true, needsConfirmation: false });
      expect(byThread.threads.callsTo("archive")).toEqual([["thr_w"]]);
    });

    it("keeps asking when a live item shares its id with an older Done one", async () => {
      const { deps, threads } = await setup("## In flight\n- [ ] fix-login - Again\n## Done\n- [x] fix-login - Before (merged 2026-09-01)\n");
      expect((await endCrew(deps, "thr_w", false)).needsConfirmation).toBe(true);
      expect(threads.callsTo("archive")).toEqual([]);
    });

    it("asks first when the backlog has no item for it, or no backlog exists", async () => {
      const { deps, threads } = await setup();
      expect(await endCrew(deps, "thr_w", false)).toEqual({ ended: false, needsConfirmation: true });
      expect(threads.callsTo("archive")).toEqual([]);
    });
  });

  it("relaunch sends one auto message to the first mate carrying the crewmate's details and the note", async () => {
    const { deps, threads } = await setup();
    await relaunchCrew(deps, "thr_w", " tests pass now ");
    expect(threads.sent).toHaveLength(1);
    expect(threads.sent[0]).toMatchObject({ id: "thr_mate", mode: "auto" });
    expect(valuesOf(threads.sent[0]?.text, "messages/relaunch.md")).toEqual({
      title: "Fix login",
      task: "fix-login",
      threadId: "thr_w",
      environmentId: "env_w",
      note: "tests pass now",
    });
  });

  it("relaunch names a thread with no task by its title", async () => {
    const { deps, threads, mate } = await setup();
    threads.add({ id: "thr_bare", title: "Bare", parentThreadId: mate.id });
    await relaunchCrew(deps, "thr_bare", "go");
    expect(valuesOf(threads.sent[0]?.text, "messages/relaunch.md")).toEqual({ title: "Bare", task: "", threadId: "thr_bare", environmentId: "", note: "go" });
  });

  it("note sends one auto message to the first mate carrying the thread id and the note", async () => {
    const { deps, threads } = await setup();
    await noteCrew(deps, "thr_w", " remember the flag ");
    expect(threads.sent).toHaveLength(1);
    expect(threads.sent[0]).toMatchObject({ id: "thr_mate", mode: "auto" });
    expect(valuesOf(threads.sent[0]?.text, "messages/board-note.md")).toEqual({
      title: "Fix login",
      threadId: "thr_w",
      note: "remember the flag",
    });
  });

  describe("a thread that is not a child of the first mate", () => {
    async function withStranger() {
      const context = await setup();
      context.threads.add({ id: "thr_x", parentThreadId: "thr_other" });
      return context;
    }

    it("is refused by every action, and nothing reaches bb", async () => {
      const { deps, threads } = await withStranger();
      const actions = [
        () => steerCrew(deps, "thr_x", "hi"),
        () => interruptCrew(deps, "thr_x"),
        () => endCrew(deps, "thr_x", true),
        () => relaunchCrew(deps, "thr_x", "hi"),
        () => noteCrew(deps, "thr_x", "hi"),
      ];
      for (const action of actions) await expect(action()).rejects.toThrow("thr_x is not in the first mate's crew.");
      expect(threads.sent).toEqual([]);
      expect(threads.callsTo("stop")).toEqual([]);
      expect(threads.callsTo("archive")).toEqual([]);
    });

    it("is refused when it does not exist, is archived, or is the first mate itself", async () => {
      const { deps, threads } = await withStranger();
      await expect(steerCrew(deps, "thr_nope", "hi")).rejects.toThrow("thr_nope is not in the first mate's crew.");
      threads.archiveNow("thr_w");
      await expect(steerCrew(deps, "thr_w", "hi")).rejects.toThrow("thr_w is not in the first mate's crew.");
      await expect(steerCrew(deps, "thr_mate", "hi")).rejects.toThrow("thr_mate is not in the first mate's crew.");
    });

    it("is refused when there is no first mate", async () => {
      const { deps, store } = await withStranger();
      await store.setMateThreadId(null);
      await expect(steerCrew(deps, "thr_w", "hi")).rejects.toThrow("thr_w is not in the first mate's crew.");
    });
  });
});
