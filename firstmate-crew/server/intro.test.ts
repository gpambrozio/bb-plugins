import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareHome } from "./home";
import { checkHomeFolder, considerIntro, dismissIntro, finishIntro, introStatus, startIntro, type IntroDeps } from "./intro";
import { launchMate } from "./mate";
import { defaultSettings, type FirstmateSettings } from "./settings";
import { TEMPLATES, message } from "./templates";
import { fakeLog, fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A scratch folder by its real path: macOS's temporary folder sits behind the /var link. */
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "firstmate-intro-")));
  tempDirs.push(dir);
  return dir;
}

/** The plugin as a new install sees it: every setting at its default, nothing stored. */
async function setup(settings: Partial<FirstmateSettings> = {}, installedVersions?: () => Promise<string[]>) {
  const current: FirstmateSettings = { ...defaultSettings(), ...settings };
  const threads = fakeThreads();
  const projects = fakeProjects();
  const store = memoryStore();
  const log = fakeLog();
  const deps: IntroDeps = {
    threads,
    projects,
    store,
    settings: async () => current,
    log,
    async setHomeDirectory(value) {
      current.homeDirectory = value;
    },
    ...(installedVersions === undefined ? {} : { installedVersions }),
  };
  return { deps, store, threads, projects, current, log };
}

/** A project of the captain's: its own agent instructions, which the guide must never touch. */
async function captainsProject(dir: string): Promise<string> {
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENTS.md"), "my own instructions");
  return project;
}

/** Asserts the project is exactly as `captainsProject` left it. */
async function expectUntouched(project: string): Promise<void> {
  expect(await readdir(project)).toEqual(["AGENTS.md"]);
  expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe("my own instructions");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** The folder holds nothing but what is named: no staging folder left beside a home. */
async function expectOnly(dir: string, names: string[]): Promise<void> {
  expect((await readdir(dir)).sort()).toEqual([...names].sort());
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

  it("never offers it to an install whose other settings were changed, or that stored anything", async () => {
    vi.stubEnv("HOME", await tempDir());
    const crew = await setup({ crewProvider: "codex", crewModel: "gpt-5" });
    expect(await considerIntro(crew.deps)).toBe("settled");
    const used = await setup();
    await used.store.setDisabledWatches(["pr-watch"]);
    expect(await considerIntro(used.deps)).toBe("settled");
  });

  it("never offers it to an update: bb keeps more than one build, or one before the guide", async () => {
    vi.stubEnv("HOME", await tempDir());
    const decide = async (builds: string[]) => considerIntro((await setup({}, async () => builds)).deps);
    // npm installs list versions; git installs list commit SHAs; a local folder lists none.
    expect(await decide(["0.11.0", "0.10.3"])).toBe("settled");
    expect(await decide(["0.10.3"])).toBe("settled");
    expect(await decide(["4f1c2d0", "9ab3e77"])).toBe("settled");
    expect(await decide(["0.11.0"])).toBe("offered");
    expect(await decide(["4f1c2d0"])).toBe("offered");
    expect(await decide([])).toBe("offered");
    // A history bb cannot give is no evidence either way: the other checks decide, and it is logged.
    const unknown = await setup({}, () => Promise.reject(new Error("no source")));
    expect(await considerIntro(unknown.deps)).toBe("offered");
    expect(unknown.log.warnings.join("\n")).toContain("no source");
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
    // Prepared beside the folder and renamed into place: the charter names the home, and nothing is left over.
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toContain(`Your home is \`${home}\``);
    await expectOnly(dir, ["FirstMate"]);
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

describe("startIntro's folder", () => {
  it("refuses . and .. in the path: a missing folder followed by .. names a project it never checked", async () => {
    const dir = await tempDir();
    const project = await captainsProject(dir);
    const { deps, threads, current } = await setup();
    await expect(startIntro(deps, { homeDirectory: join(project, "not-created") + "/..", ...PICK })).rejects.toThrow(/"\." or "\.\."/);
    await expect(startIntro(deps, { homeDirectory: `${project}/./home`, ...PICK })).rejects.toThrow(/"\." or "\.\."/);
    await expectUntouched(project);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(threads.spawned).toHaveLength(0);
  });

  it("refuses a folder filled between the check and its use, and leaves what was put there", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    await mkdir(home);
    const { deps, threads, current } = await setup();
    const started = startIntro(
      deps,
      { homeDirectory: home, ...PICK },
      { afterCheck: () => writeFile(join(home, "README.md"), "someone else's") },
    );
    await expect(started).rejects.toThrow(/changed while the guide was starting/);
    await expectOnly(home, ["README.md"]);
    await expectOnly(dir, ["home"]);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(threads.spawned).toHaveLength(0);
  });

  it("refuses a checked folder swapped for a link to a project, before or after the home is prepared", async () => {
    for (const hook of ["afterCheck", "beforePlace"] as const) {
      const dir = await tempDir();
      const project = await captainsProject(dir);
      const home = join(dir, "home");
      await mkdir(home);
      const { deps, threads } = await setup();
      const swap = async () => {
        await rm(home, { recursive: true });
        await symlink(project, home);
      };
      await expect(startIntro(deps, { homeDirectory: home, ...PICK }, { [hook]: swap })).rejects.toThrow(/changed while the guide was starting/);
      await expectUntouched(project);
      await expectOnly(dir, ["home", "project"]);
      expect(threads.spawned).toHaveLength(0);
    }
  });

  it("refuses a missing folder that appears, filled or as a link, before the new home is put in place", async () => {
    const dir = await tempDir();
    const project = await captainsProject(dir);
    const filled = join(dir, "filled");
    const linked = join(dir, "linked");
    const { deps, threads } = await setup();
    const fill = async () => {
      await mkdir(filled);
      await writeFile(join(filled, "notes.md"), "someone else's");
    };
    await expect(startIntro(deps, { homeDirectory: filled, ...PICK }, { beforePlace: fill })).rejects.toThrow(
      /changed while the guide was starting/,
    );
    await expectOnly(filled, ["notes.md"]);
    await expect(startIntro(deps, { homeDirectory: linked, ...PICK }, { beforePlace: () => symlink(project, linked) })).rejects.toThrow(
      /changed while the guide was starting/,
    );
    await expectUntouched(project);
    await expectOnly(dir, ["filled", "linked", "project"]);
    expect(threads.spawned).toHaveLength(0);
  });
});

describe("a home reached through a link", () => {
  it("is resolved once: the first mate lives in the real folder, even when the link is retargeted meanwhile", async () => {
    const dir = await tempDir();
    const project = await captainsProject(dir);
    const real = join(dir, "real");
    await mkdir(real);
    const alias = join(dir, "alias");
    await symlink(real, alias);
    const { deps, threads, current } = await setup();
    const retarget = async () => {
      await rm(alias);
      await symlink(project, alias);
    };
    await startIntro(deps, { homeDirectory: alias, ...PICK }, { beforePlace: retarget });
    await expectUntouched(project);
    expect(threads.spawned[0]!.environment).toEqual({ kind: "path", path: real });
    expect(await readFile(join(real, "AGENTS.md"), "utf8")).toContain(`Your home is \`${real}\``);
    // The setting names the folder the first mate lives in, not the link.
    expect(current.homeDirectory).toBe(real);
  });

  it("resolves a link among the parents too, before the folder is created", async () => {
    const dir = await tempDir();
    const project = await captainsProject(dir);
    const parent = join(dir, "parent");
    await mkdir(parent);
    const linked = join(dir, "linked");
    await symlink(parent, linked);
    const { deps, threads } = await setup();
    const retarget = async () => {
      await rm(linked);
      await symlink(project, linked);
    };
    await startIntro(deps, { homeDirectory: join(linked, "Ship"), ...PICK }, { beforePlace: retarget });
    await expectUntouched(project);
    expect(threads.spawned[0]!.environment).toEqual({ kind: "path", path: join(parent, "Ship") });
    expect(await exists(join(parent, "Ship", "AGENTS.md"))).toBe(true);
  });
});

describe("overlapping starts", () => {
  it("launches the first guide in its own home with its own model; the second is refused and writes nothing", async () => {
    const dir = await tempDir();
    const { deps, threads, current } = await setup();
    const [first, second] = await Promise.allSettled([
      startIntro(deps, { homeDirectory: join(dir, "a"), providerId: "claude-code", model: "opus" }),
      startIntro(deps, { homeDirectory: join(dir, "b"), providerId: "codex", model: "gpt-5" }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/already aboard/) }) });
    expect(threads.spawned).toHaveLength(1);
    expect(threads.spawned[0]).toMatchObject({ providerId: "claude-code", model: "opus", environment: { kind: "path", path: join(dir, "a") } });
    expect(current.homeDirectory).toBe(join(dir, "a"));
    await expectOnly(dir, ["a"]);
  });

  it("keeps a launch from settings that lands meanwhile out of the guide's home", async () => {
    const dir = await tempDir();
    const { deps, threads, current } = await setup({ homeDirectory: join(dir, "settings-home") });
    const [guide, launch] = await Promise.allSettled([
      startIntro(deps, { homeDirectory: join(dir, "guide-home"), ...PICK }),
      launchMate(deps, { providerId: "codex", model: "gpt-5" }),
    ]);
    expect(guide.status).toBe("fulfilled");
    expect(launch.status).toBe("rejected");
    expect(threads.spawned).toHaveLength(1);
    expect(threads.spawned[0]!.environment).toEqual({ kind: "path", path: join(dir, "guide-home") });
    expect(current.homeDirectory).toBe(join(dir, "guide-home"));
  });
});

describe("a failed start", () => {
  /** Spawns that run `during` while bb is still answering, then refuse. */
  function refuseSpawn(threads: ReturnType<typeof fakeThreads>, during: () => Promise<void> = async () => {}) {
    threads.spawn = async () => {
      await during();
      throw new Error("provider refused");
    };
  }

  it("keeps the setting and deletes nothing: the placed home and its project stay", async () => {
    const dir = await tempDir();
    const home = join(dir, "new", "home");
    const { deps, threads, projects, store, current } = await setup();
    await store.setIntroState("offered");
    refuseSpawn(threads);
    await expect(startIntro(deps, { homeDirectory: home, ...PICK })).rejects.toThrow(/provider refused/);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(await exists(join(home, "AGENTS.md"))).toBe(true);
    expect(projects.projects.map((project) => project.path)).toEqual([home]);
    expect(await store.mateThreadId()).toBeNull();
    expect(await store.introState()).toBe("offered");
  });

  it("keeps what the captain wrote in the home while the spawn was pending", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    const { deps, threads } = await setup();
    refuseSpawn(threads, async () => {
      await writeFile(join(home, "notes.md"), "valuable notes");
      await writeFile(join(home, "data", "backlog.md"), "an edited backlog");
    });
    await expect(startIntro(deps, { homeDirectory: home, ...PICK })).rejects.toThrow(/provider refused/);
    expect(await readFile(join(home, "notes.md"), "utf8")).toBe("valuable notes");
    expect(await readFile(join(home, "data", "backlog.md"), "utf8")).toBe("an edited backlog");
  });

  it("keeps an empty folder's placed home when the project cannot be registered", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    await mkdir(home);
    await writeFile(join(home, ".DS_Store"), "finder");
    const { deps, projects, current } = await setup();
    projects.failNextCreate(new Error("bb refused the project"));
    await expect(startIntro(deps, { homeDirectory: home, ...PICK })).rejects.toThrow(/bb refused the project/);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(await readFile(join(home, ".DS_Store"), "utf8")).toBe("finder");
    expect(await exists(join(home, "AGENTS.md"))).toBe(true);
  });

  it("removes only a staging folder that was never placed when preparing fails", async () => {
    const dir = await tempDir();
    const { deps, threads, current } = await setup();
    const failing = () => Promise.reject(new Error("disk full"));
    await expect(startIntro(deps, { homeDirectory: join(dir, "new", "home"), ...PICK }, { beforePlace: failing })).rejects.toThrow(/disk full/);
    await expectOnly(join(dir, "new"), []);
    expect(current.homeDirectory).toBe("~/FirstMate");
    expect(threads.spawned).toHaveLength(0);
  });

  it("names a first mate that started but could not be recorded, and leaves it running in its home", async () => {
    for (const registered of [false, true]) {
      const dir = await tempDir();
      const home = join(dir, "home");
      const { deps, threads, projects, store, current } = await setup();
      if (registered) projects.projects.push({ id: "prj_home", name: "FirstMate", path: home });
      store.setMateThreadId = () => Promise.reject(new Error("storage is down"));
      const error = await startIntro(deps, { homeDirectory: home, ...PICK }).catch((caught: Error) => caught);
      expect(threads.spawned).toHaveLength(1);
      expect(String(error)).toMatch(/started \(thr_[^)]+\).*storage is down.*Try again to adopt this first mate/);
      expect(threads.callsTo("stop")).toEqual([]);
      expect(await exists(join(home, "AGENTS.md"))).toBe(true);
      expect(projects.projects).toHaveLength(1);
      expect(current.homeDirectory).toBe("~/FirstMate");
    }
  });

  it("adopts the first mate it started when Start is pressed again after the record failed", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    const { deps, threads, store, current } = await setup();
    const save = store.setMateThreadId.bind(store);
    let failures = 1;
    store.setMateThreadId = (id) => (failures-- > 0 ? Promise.reject(new Error("storage is down")) : save(id));
    const error = await startIntro(deps, { homeDirectory: home, ...PICK }).catch((caught: Error) => caught);
    expect(String(error)).toMatch(/Try again to adopt this first mate/);
    const firstId = /started \((thr_[^)]+)\)/.exec(String(error))![1]!;

    const mate = await startIntro(deps, { homeDirectory: home, ...PICK });
    expect(mate.id).toBe(firstId);
    expect(threads.spawned).toHaveLength(1);
    expect(await store.mateThreadId()).toBe(mate.id);
    expect(current.homeDirectory).toBe(home);
    expect(await store.introState()).toBe("done");
  });

  it("starts a new first mate on the retry when the unrecorded one is gone, and refuses another folder while it waits", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    const { deps, threads, store } = await setup();
    const save = store.setMateThreadId.bind(store);
    let failures = 1;
    store.setMateThreadId = (id) => (failures-- > 0 ? Promise.reject(new Error("storage is down")) : save(id));
    const error = await startIntro(deps, { homeDirectory: home, ...PICK }).catch((caught: Error) => caught);
    const firstId = /started \((thr_[^)]+)\)/.exec(String(error))![1]!;

    await expect(startIntro(deps, { homeDirectory: join(dir, "elsewhere"), ...PICK })).rejects.toThrow(/still waiting to be recorded/);
    expect(threads.spawned).toHaveLength(1);

    threads.archiveNow(firstId);
    const mate = await startIntro(deps, { homeDirectory: home, ...PICK });
    expect(mate.id).not.toBe(firstId);
    expect(threads.spawned).toHaveLength(2);
    expect(await store.mateThreadId()).toBe(mate.id);
  });

  it("leaves an earlier home as it is", async () => {
    const dir = await tempDir();
    const home = join(dir, "home");
    await mkdir(home);
    await prepareHome(home, { crewProvider: "", crewReasoning: "" });
    await writeFile(join(home, "data", "backlog.md"), "the captain's backlog");
    const before = (await readdir(home)).sort();
    const { deps, threads } = await setup();
    refuseSpawn(threads);
    await expect(startIntro(deps, { homeDirectory: home, ...PICK })).rejects.toThrow(/provider refused/);
    expect((await readdir(home)).sort()).toEqual(before);
    expect(await readFile(join(home, "data", "backlog.md"), "utf8")).toBe("the captain's backlog");
  });
});
