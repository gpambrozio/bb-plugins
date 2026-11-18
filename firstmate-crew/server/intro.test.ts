import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareHome } from "./home";
import { checkHomeFolder, considerIntro, dismissIntro, finishIntro, introStatus, startIntro, type IntroDeps } from "./intro";
import { defaultSettings, type FirstmateSettings } from "./settings";
import { TEMPLATES, message } from "./templates";
import { fakeLog, fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-intro-"));
  tempDirs.push(dir);
  return dir;
}

/** The plugin as a new install sees it: every setting at its default, nothing stored. */
async function setup(settings: Partial<FirstmateSettings> = {}) {
  const current: FirstmateSettings = { ...defaultSettings(), ...settings };
  const threads = fakeThreads();
  const store = memoryStore();
  const deps: IntroDeps = {
    threads,
    projects: fakeProjects(),
    store,
    settings: async () => current,
    log: fakeLog(),
    async setHomeDirectory(value) {
      current.homeDirectory = value;
    },
  };
  return { deps, store, threads, current };
}

const PICK = { providerId: "claude-code", model: "opus" };

describe("considerIntro", () => {
  it("offers the guide to a new install: no first mate, the default home and nothing prepared there", async () => {
    // The default home is ~/FirstMate; point the user's home folder somewhere empty.
    const fakeHome = await tempDir();
    vi.stubEnv("HOME", fakeHome);
    expect(homedir()).toBe(fakeHome);
    const { deps, store } = await setup();
    expect(await considerIntro(deps)).toBe("offered");
    expect(await store.introState()).toBe("offered");
    expect(await introStatus(deps)).toEqual({ offer: true, homeDirectory: "~/FirstMate" });
  });

  it("never offers it to an install that already has a first mate", async () => {
    const { deps, store } = await setup();
    await store.setMateThreadId("thr_mate");
    expect(await considerIntro(deps)).toBe("settled");
    expect((await introStatus(deps)).offer).toBe(false);
  });

  it("never offers it to an install whose home setting was changed", async () => {
    const { deps } = await setup({ homeDirectory: "/somewhere/else" });
    expect(await considerIntro(deps)).toBe("settled");
  });

  it("never offers it when the default home was already prepared by an earlier launch", async () => {
    const fakeHome = await tempDir();
    vi.stubEnv("HOME", fakeHome);
    const home = join(fakeHome, "FirstMate");
    await mkdir(home, { recursive: true });
    await prepareHome(home, { crewProvider: "", crewReasoning: "" });
    const { deps } = await setup();
    expect(await considerIntro(deps)).toBe("settled");
  });

  it("decides once: a settled install stays settled after its first mate is released", async () => {
    const { deps, store } = await setup();
    await store.setMateThreadId("thr_mate");
    await considerIntro(deps);
    await store.setMateThreadId(null);
    expect(await considerIntro(deps)).toBe("settled");
  });

  it("stops offering once dismissed, and once a first mate came aboard", async () => {
    const fakeHome = await tempDir();
    vi.stubEnv("HOME", fakeHome);
    const { deps } = await setup();
    await considerIntro(deps);
    await dismissIntro(deps);
    expect((await introStatus(deps)).offer).toBe(false);

    const other = await setup();
    await considerIntro(other.deps);
    await finishIntro(other.deps);
    expect(await introStatus(other.deps)).toMatchObject({ offer: false });
  });
});

describe("checkHomeFolder", () => {
  it("takes a folder that does not exist, an empty one, or an earlier home", async () => {
    const dir = await tempDir();
    await checkHomeFolder(join(dir, "new"));
    await mkdir(join(dir, "empty"));
    await writeFile(join(dir, "empty", ".DS_Store"), "");
    await checkHomeFolder(join(dir, "empty"));
    await mkdir(join(dir, "home"));
    await prepareHome(join(dir, "home"), { crewProvider: "", crewReasoning: "" });
    await checkHomeFolder(join(dir, "home"));
  });

  it("refuses a folder holding other files, and a file", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "project"));
    await writeFile(join(dir, "project", "AGENTS.md"), "my own instructions");
    await expect(checkHomeFolder(join(dir, "project"))).rejects.toThrow(/already holds other files/);
    await writeFile(join(dir, "file"), "");
    await expect(checkHomeFolder(join(dir, "file"))).rejects.toThrow(/is a file, not a folder/);
  });
});

describe("startIntro", () => {
  it("writes the home setting, launches the first mate with the first-session prompt, and finishes the guide", async () => {
    const dir = await tempDir();
    const home = join(dir, "FirstMate");
    const { deps, threads, store, current } = await setup();
    await considerIntro(deps);

    const mate = await startIntro(deps, { homeDirectory: ` ${home} `, ...PICK, reasoningLevel: "high" });

    expect(current.homeDirectory).toBe(home);
    expect(await store.mateThreadId()).toBe(mate.id);
    expect(await store.introState()).toBe("done");
    const [spawn] = threads.spawned;
    expect(spawn).toMatchObject({ providerId: "claude-code", model: "opus", reasoningLevel: "high", pinned: true });
    expect(spawn!.environment).toEqual({ kind: "path", path: home });
    expect(spawn!.prompt).toContain("You are the first mate");
    expect(spawn!.prompt.endsWith(await message(TEMPLATES.firstSession))).toBe(true);
  });

  it("refuses before changing anything when a first mate is aboard", async () => {
    const dir = await tempDir();
    const { deps, threads, current } = await setup();
    const mate = threads.add({ title: "First mate" });
    await deps.store.setMateThreadId(mate.id);
    await expect(startIntro(deps, { homeDirectory: join(dir, "home"), ...PICK })).rejects.toThrow(/already aboard/);
    expect(current.homeDirectory).toBe("~/FirstMate");
  });

  it("refuses a folder that is neither new, empty nor a home, and keeps the setting and the offer", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "README.md"), "a project");
    const { deps, threads, store, current } = await setup();
    await store.setIntroState("offered");
    await expect(startIntro(deps, { homeDirectory: dir, ...PICK })).rejects.toThrow(/already holds other files/);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(threads.spawned).toHaveLength(0);
    expect(await store.introState()).toBe("offered");
  });

  it("refuses a relative folder with the setting's own sentence", async () => {
    const { deps } = await setup();
    await expect(startIntro(deps, { homeDirectory: "FirstMate", ...PICK })).rejects.toThrow(/absolute path or start with ~/);
  });
});
