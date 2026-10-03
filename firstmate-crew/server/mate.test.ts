import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CREW_METADATA, STATE_DIR, type ThreadStatus } from "../shared/types";
import { readOpening } from "./home";
import {
  MATE_TITLE,
  PROJECT_NAME,
  adoptMate,
  askMate,
  commandText,
  compactMate,
  launchMate,
  releaseMate,
  requireMate,
  resolveMate,
  restartMate,
  type MateDeps,
} from "./mate";
import type { FirstmateSettings } from "./settings";
import { TEMPLATES, message } from "./templates";
import { fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A home that does not exist yet, inside a fresh temp directory, so a launch has to create it. */
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-mate-"));
  tempDirs.push(dir);
  return join(dir, "home");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setup(options: { projects?: { id: string; path: string }[] } = {}) {
  const home = await tempHome();
  const threads = fakeThreads();
  const projects = fakeProjects(options.projects?.map((project) => ({ ...project, path: project.path === "<home>" ? home : project.path })));
  const store = memoryStore();
  const settings: FirstmateSettings = {
    homeDirectory: home,
    crewProvider: "",
    crewModel: "",
    crewReasoning: "default",
    refreshSeconds: 10,
  };
  const deps: MateDeps = { threads, projects, store, settings: async () => settings };
  return { home, threads, projects, store, deps };
}

const PICK = { providerId: "claude-code", model: "opus" };

describe("launchMate", () => {
  it("launch creates the project and a pinned first mate in the home, and stores its id", async () => {
    const { home, threads, projects, store, deps } = await setup();

    const mate = await launchMate(deps, PICK);

    expect(projects.created).toEqual([{ id: expect.any(String), name: PROJECT_NAME, path: home }]);
    expect(threads.spawned).toHaveLength(1);
    const spawn = threads.spawned[0]!;
    expect(spawn.environment).toEqual({ kind: "path", path: home });
    expect(spawn.environment.kind).toBe("path");
    expect(spawn.title).toBe("First mate");
    expect(spawn.title).toBe(MATE_TITLE);
    expect(spawn.metadata.role).toBe("first-mate");
    expect(spawn.metadata[CREW_METADATA.role]).toBe(CREW_METADATA.mateRole);
    expect(spawn.projectId).toBe(projects.created[0]!.id);
    expect(spawn.providerId).toBe("claude-code");
    expect(spawn.model).toBe("opus");
    expect(spawn.prompt).toBe(await readOpening(home));
    expect(spawn.pinned).toBe(true);
    expect(await store.mateThreadId()).toBe(mate.id);
    expect(await exists(join(home, STATE_DIR))).toBe(true);
  });

  it("launch reuses an existing project at the home path", async () => {
    const { threads, projects, deps } = await setup({ projects: [{ id: "prj_home", path: "<home>" }] });

    await launchMate(deps, PICK);

    expect(projects.created).toEqual([]);
    expect(threads.spawned[0]!.projectId).toBe("prj_home");
  });

  it("passes the picked reasoning level through", async () => {
    const { threads, deps } = await setup();

    await launchMate(deps, { ...PICK, reasoningLevel: "high" });

    expect(threads.spawned[0]!.reasoningLevel).toBe("high");
  });

  it("launch refuses while a stored first mate still resolves", async () => {
    const { threads, store, deps } = await setup();
    const current = threads.add({ status: "idle" });
    await store.setMateThreadId(current.id);

    await expect(launchMate(deps, PICK)).rejects.toThrow(`A first mate is already aboard (${current.id}). Release it first.`);
    expect(threads.spawned).toEqual([]);
  });

  it("launches again once the stored first mate is gone", async () => {
    const { threads, store, deps } = await setup();
    const old = threads.add({ status: "idle" });
    await store.setMateThreadId(old.id);
    threads.archiveNow(old.id);

    const mate = await launchMate(deps, PICK);

    expect(await store.mateThreadId()).toBe(mate.id);
  });

  it("launch is serialized: two concurrent launches spawn once", async () => {
    const { threads, deps } = await setup();

    const results = await Promise.allSettled([launchMate(deps, PICK), launchMate(deps, PICK)]);

    expect(threads.spawned).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected");
    expect(String((refused as PromiseRejectedResult).reason)).toContain("A first mate is already aboard");
  });

  it("a spawn failure leaves no stored id and the error says the first mate could not be started, with the cause", async () => {
    const { threads, store, deps } = await setup();
    threads.failSpawn(new Error("provider exploded"));

    const launch = launchMate(deps, PICK);

    await expect(launch).rejects.toThrow("The first mate could not be started: provider exploded");
    await expect(launch.catch((error: Error) => (error.cause as Error).message)).resolves.toBe("provider exploded");
    expect(await store.mateThreadId()).toBeNull();
  });
});

describe("resolveMate", () => {
  it("resolveMate ignores a first-mate-metadata thread that is not the stored id", async () => {
    const { threads, store, deps } = await setup();
    const impostor = threads.add({ status: "idle", title: MATE_TITLE });
    threads.setMetadata(impostor.id, { role: "first-mate" });

    expect(await resolveMate(deps)).toBeNull();

    const stored = threads.add({ status: "idle" });
    await store.setMateThreadId(stored.id);
    expect((await resolveMate(deps))?.id).toBe(stored.id);
  });

  it("returns null when the stored thread is gone", async () => {
    const { threads, store, deps } = await setup();
    await store.setMateThreadId("thr_missing");
    expect(await resolveMate(deps)).toBeNull();

    const archived = threads.add({ status: "idle" });
    threads.archiveNow(archived.id);
    await store.setMateThreadId(archived.id);
    expect(await resolveMate(deps)).toBeNull();
  });
});

describe("restartMate", () => {
  const MID_TURN: ThreadStatus[] = ["active", "starting", "pending", "stopping"];

  for (const status of MID_TURN) {
    it(`restart refuses mid-turn (${status})`, async () => {
      const { threads, store, deps } = await setup();
      const mate = threads.add({ status });
      await store.setMateThreadId(mate.id);

      await expect(restartMate(deps)).rejects.toThrow("Restart refused: the first mate is mid-turn.");
      expect(threads.callsTo("clearContext")).toEqual([]);
      expect(threads.sent).toEqual([]);
    });
  }

  it("restart refuses when no first mate is aboard", async () => {
    const { threads, deps } = await setup();

    await expect(restartMate(deps)).rejects.toThrow("No first mate aboard.");
    expect(threads.calls).toEqual([]);
  });

  for (const status of ["idle", "error"] as const) {
    it(`restart clears context then sends opening + restart note with mode auto (${status})`, async () => {
      const { home, threads, store, deps } = await setup();
      const mate = threads.add({ status });
      await store.setMateThreadId(mate.id);

      await restartMate(deps);

      const mutations = threads.calls.filter((call) => call.method === "clearContext" || call.method === "send");
      expect(mutations.map((call) => call.method)).toEqual(["clearContext", "send"]);
      expect(threads.callsTo("clearContext")).toEqual([[mate.id]]);
      const expected = `${await readOpening(home)}\n\n${await message(TEMPLATES.restartNote)}`;
      expect(threads.sent).toEqual([{ id: mate.id, text: expected, mode: "auto" }]);
      expect(await store.mateThreadId()).toBe(mate.id);
    });
  }
});

describe("compactMate", () => {
  for (const status of ["active", "starting", "pending", "stopping"] as const) {
    it(`compact refuses mid-turn (${status})`, async () => {
      const { threads, store, deps } = await setup();
      const mate = threads.add({ status });
      await store.setMateThreadId(mate.id);

      await expect(compactMate(deps)).rejects.toThrow("Compact refused: the first mate is mid-turn.");
      expect(threads.callsTo("compact")).toEqual([]);
    });
  }

  it("compact refuses when no first mate is aboard", async () => {
    const { threads, deps } = await setup();

    await expect(compactMate(deps)).rejects.toThrow("No first mate aboard.");
    expect(threads.calls).toEqual([]);
  });

  for (const status of ["idle", "error"] as const) {
    it(`compact asks bb to compact the first mate's thread and sends nothing (${status})`, async () => {
      const { threads, store, deps } = await setup();
      const mate = threads.add({ status });
      await store.setMateThreadId(mate.id);

      await compactMate(deps);

      expect(threads.callsTo("compact")).toEqual([[mate.id]]);
      expect(threads.sent).toEqual([]);
    });
  }
});

describe("releaseMate", () => {
  it("release forgets the id and touches no thread", async () => {
    const { threads, store, deps } = await setup();
    const mate = threads.add({ status: "active" });
    await store.setMateThreadId(mate.id);
    threads.calls.length = 0;

    await releaseMate(deps);

    expect(await store.mateThreadId()).toBeNull();
    expect(threads.calls).toEqual([]);
    expect((await threads.get(mate.id))?.archivedAt).toBeNull();
  });
});

describe("adoptMate", () => {
  it("adopt refuses an unknown thread", async () => {
    const { store, deps } = await setup();

    await expect(adoptMate(deps, "thr_nope")).rejects.toThrow("thr_nope");
    expect(await store.mateThreadId()).toBeNull();
  });

  it("adopt refuses while another first mate is aboard", async () => {
    const { threads, store, deps } = await setup();
    const current = threads.add({ status: "idle" });
    const other = threads.add({ status: "idle" });
    await store.setMateThreadId(current.id);

    await expect(adoptMate(deps, other.id)).rejects.toThrow(`A first mate is already aboard (${current.id}). Release it first.`);
    expect(await store.mateThreadId()).toBe(current.id);
  });

  it("adopt prepares the home and stores the thread's id", async () => {
    const { home, threads, store, deps } = await setup();
    const thread = threads.add({ status: "idle", environmentId: "env_home" });
    threads.setWorkspace("env_home", home);

    const adopted = await adoptMate(deps, thread.id);

    expect(adopted.id).toBe(thread.id);
    expect(await store.mateThreadId()).toBe(thread.id);
    expect(await exists(join(home, STATE_DIR))).toBe(true);
    expect(threads.spawned).toEqual([]);
  });
});

describe("adoptMate and the home", () => {
  it("refuses a thread working somewhere other than the home, naming the home, and prepares nothing", async () => {
    const { home, threads, store, deps } = await setup();
    const thread = threads.add({ status: "idle", environmentId: "env_web" });
    threads.setWorkspace("env_web", "/checkouts/web");

    await expect(adoptMate(deps, thread.id)).rejects.toThrow(
      `Only a thread working in the first mate's home (${home}) can be adopted.`,
    );
    expect(await store.mateThreadId()).toBeNull();
    expect(await exists(home)).toBe(false);
  });

  it("refuses a thread with no environment, or one on another machine", async () => {
    const { home, threads, store, deps } = await setup();
    const bare = threads.add({ status: "idle", environmentId: null });
    // No workspace recorded for env_remote: the port answers null, as for another machine.
    const remote = threads.add({ status: "idle", environmentId: "env_remote" });

    await expect(adoptMate(deps, bare.id)).rejects.toThrow(`(${home})`);
    await expect(adoptMate(deps, remote.id)).rejects.toThrow(`(${home})`);
    expect(await store.mateThreadId()).toBeNull();
  });

  it("adopts a thread whose workspace reaches the home through a symlink", async () => {
    const { home, threads, store, deps } = await setup();
    await mkdir(home, { recursive: true });
    const link = `${home}-link`;
    await symlink(home, link);
    const thread = threads.add({ status: "idle", environmentId: "env_link" });
    threads.setWorkspace("env_link", link);

    await adoptMate(deps, thread.id);
    expect(await store.mateThreadId()).toBe(thread.id);
  });
});

describe("carrying words to the first mate", () => {
  it("requireMate names what to do when there is none", async () => {
    const { deps } = await setup();

    await expect(requireMate(deps)).rejects.toThrow("No first mate aboard. Launch one in FirstMate settings.");
    await expect(askMate(deps, "hello")).rejects.toThrow("No first mate aboard. Launch one in FirstMate settings.");
  });

  it("askMate sends the captain's words with mode auto", async () => {
    const { threads, store, deps } = await setup();
    const mate = threads.add({ status: "active" });
    await store.setMateThreadId(mate.id);

    await askMate(deps, "Ship it.");

    expect(threads.sent).toEqual([{ id: mate.id, text: "Ship it.", mode: "auto" }]);
  });

  it("commandText uses the -args template only when there are words after the command", async () => {
    expect(await commandText("bearings", "  ")).toBe(await message(TEMPLATES.bearings));
    expect(await commandText("ahoy", "")).toBe(await message(TEMPLATES.ahoy));
    expect(await commandText("bearings", " the api ")).toBe(await message(TEMPLATES.bearingsArgs, { args: "the api" }));
    expect(await commandText("ahoy", "ship")).toBe(await message(TEMPLATES.ahoyArgs, { args: "ship" }));
  });
});
