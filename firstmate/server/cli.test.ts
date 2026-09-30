import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CREW_METADATA } from "../shared/types";
import { firstmateCli } from "./cli";
import type { MateDeps } from "./mate";
import type { FirstmateSettings } from "./settings";
import { fakeProjects, fakeThreads, memoryStore } from "./testing/fakes";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BRIEF = "# Fix the login redirect\n\nThe redirect drops the query string.\n";

async function setup(overrides: Partial<FirstmateSettings> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "firstmate-cli-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "brief.md"), BRIEF, "utf8");
  const threads = fakeThreads();
  const store = memoryStore();
  const settings: FirstmateSettings = {
    homeDirectory: "~/FirstMate",
    crewProvider: "",
    crewModel: "",
    crewReasoning: "default",
    refreshSeconds: 10,
    ...overrides,
  };
  const projects = fakeProjects([
    { id: "prj_app", name: "App", path: "/work/app" },
    { id: "prj_site", name: "Site", path: "/work/site" },
  ]);
  const deps: MateDeps = { threads, projects, store, settings: async () => settings };
  const mate = threads.add({ id: "thr_mate", title: "First mate" });
  await store.setMateThreadId(mate.id);
  const cli = firstmateCli(deps);
  return { dir, threads, store, deps, cli, mate };
}

const SPAWN = ["crew", "spawn", "--task", "fix-login", "--project", "prj_app", "--prompt-file", "brief.md"];

describe("bb firstmate crew spawn", () => {
  it("crew spawn from the first mate spawns a worktree child with crew metadata and prints its id", async () => {
    const { cli, threads, dir } = await setup();

    const result = await cli.run([...SPAWN, "--kind", "bugfix"], { threadId: "thr_mate", cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(threads.spawned).toHaveLength(1);
    const spawned = threads.spawned[0]!;
    expect(spawned).toMatchObject({
      projectId: "prj_app",
      parentThreadId: "thr_mate",
      environment: { kind: "worktree" },
      prompt: BRIEF,
      title: "fix-login: Fix the login redirect",
      metadata: { [CREW_METADATA.role]: "crew", [CREW_METADATA.task]: "fix-login", [CREW_METADATA.kind]: "bugfix", [CREW_METADATA.project]: "prj_app" },
    });
    expect(spawned.providerId).toBeUndefined();
    expect(spawned.model).toBeUndefined();
    expect(spawned.reasoningLevel).toBeUndefined();
    const newId = [...threads.threads.keys()].find((id) => id !== "thr_mate");
    expect(result.stdout).toBe(`${newId}\n`);
  });

  it("prints the new thread id as JSON with --json", async () => {
    const { cli, threads, dir } = await setup();
    const result = await cli.run([...SPAWN, "--json"], { threadId: "thr_mate", cwd: dir });
    const newId = [...threads.threads.keys()].find((id) => id !== "thr_mate");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({ threadId: newId });
  });

  it("omits the kind from the metadata when none is given, and resolves the project by exact name", async () => {
    const { cli, threads, dir } = await setup();
    const argv = ["crew", "spawn", "--task", "t1", "--project", "Site", "--prompt-file", "brief.md"];
    const result = await cli.run(argv, { threadId: "thr_mate", cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(threads.spawned[0]!.projectId).toBe("prj_site");
    expect(threads.spawned[0]!.metadata).toEqual({ role: "crew", task: "t1", project: "Site" });
  });

  it("titles with --title when given, and caps a long first line of the brief", async () => {
    const { cli, threads, dir } = await setup();
    await cli.run([...SPAWN, "--title", "Login redirect"], { threadId: "thr_mate", cwd: dir });
    expect(threads.spawned[0]!.title).toBe("Login redirect");

    await writeFile(join(dir, "long.md"), `\n\n## ${"x".repeat(200)}\nmore\n`, "utf8");
    await cli.run(["crew", "spawn", "--task", "t2", "--project", "prj_app", "--prompt-file", "long.md"], { threadId: "thr_mate", cwd: dir });
    const title = threads.spawned[1]!.title;
    expect(title.startsWith("t2: xxx")).toBe(true);
    expect(title.length).toBeLessThanOrEqual("t2: ".length + 80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("an unknown project fails and spawns nothing", async () => {
    const { cli, threads, dir } = await setup();
    const argv = ["crew", "spawn", "--task", "t", "--project", "Nope", "--prompt-file", "brief.md"];
    const result = await cli.run(argv, { threadId: "thr_mate", cwd: dir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown project: Nope");
    expect(threads.spawned).toEqual([]);
  });

  describe("provider, model and reasoning", () => {
    it("crew spawn applies the settings' crew model unless --provider/--model are given", async () => {
      const { cli, threads, dir } = await setup({ crewProvider: "codex", crewModel: "gpt-5", crewReasoning: "high" });

      await cli.run(SPAWN, { threadId: "thr_mate", cwd: dir });
      expect(threads.spawned[0]).toMatchObject({ providerId: "codex", model: "gpt-5", reasoningLevel: "high" });

      await cli.run([...SPAWN, "--provider", "claude-code", "--model", "opus", "--reasoning", "low"], { threadId: "thr_mate", cwd: dir });
      expect(threads.spawned[1]).toMatchObject({ providerId: "claude-code", model: "opus", reasoningLevel: "low" });
    });

    it("leaves the model out when the settings name no provider", async () => {
      const { cli, threads, dir } = await setup({ crewModel: "gpt-5" });
      await cli.run(SPAWN, { threadId: "thr_mate", cwd: dir });
      expect(threads.spawned[0]!.providerId).toBeUndefined();
      expect(threads.spawned[0]!.model).toBeUndefined();
    });

    it("--provider without --model (and the reverse) fails and spawns nothing", async () => {
      const { cli, threads, dir } = await setup();
      const providerOnly = await cli.run([...SPAWN, "--provider", "codex"], { threadId: "thr_mate", cwd: dir });
      const modelOnly = await cli.run([...SPAWN, "--model", "opus"], { threadId: "thr_mate", cwd: dir });
      expect(providerOnly.exitCode).not.toBe(0);
      expect(modelOnly.exitCode).not.toBe(0);
      expect(threads.spawned).toEqual([]);
    });
  });

  it("crew spawn --environment reuses that environment", async () => {
    const { cli, threads, dir } = await setup();
    const result = await cli.run([...SPAWN, "--environment", "env_old"], { threadId: "thr_mate", cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(threads.spawned[0]!.environment).toEqual({ kind: "reuse", environmentId: "env_old" });
  });

  describe("who may spawn", () => {
    it("crew spawn from another thread is refused and spawns nothing", async () => {
      const { cli, threads, dir } = await setup();
      const result = await cli.run(SPAWN, { threadId: "thr_other", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("crew spawn is only for the first mate (caller thr_other is not it).");
      expect(threads.spawned).toEqual([]);
    });

    it("crew spawn without ctx.threadId is refused", async () => {
      const { cli, threads, dir } = await setup();
      const result = await cli.run(SPAWN, { cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("crew spawn must run inside the first mate's thread.");
      expect(threads.spawned).toEqual([]);
    });

    it("crew spawn with the stored first mate gone is refused", async () => {
      const { cli, threads, dir } = await setup();
      threads.archiveNow("thr_mate");
      const result = await cli.run(SPAWN, { threadId: "thr_mate", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("No first mate aboard");
      expect(threads.spawned).toEqual([]);
    });

    it("crew spawn with no first mate stored is refused", async () => {
      const { cli, threads, store, dir } = await setup();
      await store.setMateThreadId(null);
      const result = await cli.run(SPAWN, { threadId: "thr_mate", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(threads.spawned).toEqual([]);
    });
  });

  describe("--prompt-file", () => {
    it("--prompt-file relative to ctx.cwd is read from there; a missing file names the resolved path and spawns nothing", async () => {
      const { cli, threads, dir } = await setup();
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "other.md"), "Other brief\n", "utf8");

      const found = await cli.run(["crew", "spawn", "--task", "t", "--project", "prj_app", "--prompt-file", "sub/other.md"], { threadId: "thr_mate", cwd: dir });
      expect(found.exitCode).toBe(0);
      expect(threads.spawned[0]!.prompt).toBe("Other brief\n");
      expect(threads.spawned[0]!.title).toBe("t: Other brief");

      const missing = await cli.run(["crew", "spawn", "--task", "t", "--project", "prj_app", "--prompt-file", "sub/nope.md"], { threadId: "thr_mate", cwd: dir });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain(`Prompt file not found: ${join(dir, "sub", "nope.md")}`);
      expect(threads.spawned).toHaveLength(1);
    });

    it("an absolute path is used as it is, and an empty brief is refused", async () => {
      const { cli, threads, dir } = await setup();
      const empty = join(dir, "empty.md");
      await writeFile(empty, "  \n\n", "utf8");
      const ok = await cli.run(["crew", "spawn", "--task", "t", "--project", "prj_app", "--prompt-file", join(dir, "brief.md")], { threadId: "thr_mate", cwd: "/" });
      expect(ok.exitCode).toBe(0);
      const refused = await cli.run(["crew", "spawn", "--task", "t", "--project", "prj_app", "--prompt-file", empty], { threadId: "thr_mate", cwd: dir });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(`Prompt file is empty: ${empty}`);
      expect(threads.spawned).toHaveLength(1);
    });
  });

  describe("validation", () => {
    it.each([
      ["--task", ["crew", "spawn", "--project", "prj_app", "--prompt-file", "brief.md"]],
      ["--project", ["crew", "spawn", "--task", "t", "--prompt-file", "brief.md"]],
      ["--prompt-file", ["crew", "spawn", "--task", "t", "--project", "prj_app"]],
    ])("a missing %s fails and spawns nothing", async (flag, argv) => {
      const { cli, threads, dir } = await setup();
      const result = await cli.run(argv, { threadId: "thr_mate", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(flag);
      expect(threads.spawned).toEqual([]);
    });

    it("an unknown flag fails and spawns nothing", async () => {
      const { cli, threads, dir } = await setup();
      const result = await cli.run([...SPAWN, "--bogus", "1"], { threadId: "thr_mate", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--bogus");
      expect(threads.spawned).toEqual([]);
    });

    it("a spawn that bb refuses fails with its reason", async () => {
      const { cli, threads, dir } = await setup();
      threads.failSpawn(new Error("environment env_x not found"));
      const result = await cli.run(SPAWN, { threadId: "thr_mate", cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("environment env_x not found");
    });
  });
});

describe("bb firstmate tell", () => {
  it("tell sends one auto message to the first mate", async () => {
    const { cli, threads } = await setup();
    const result = await cli.run(["tell", "ship", "the", "release", "today"], {});
    expect(result.exitCode).toBe(0);
    expect(threads.sent).toEqual([{ id: "thr_mate", text: "ship the release today", mode: "auto" }]);
  });

  it("tell without words fails and sends nothing", async () => {
    const { cli, threads } = await setup();
    const result = await cli.run(["tell"], {});
    expect(result.exitCode).not.toBe(0);
    expect(threads.sent).toEqual([]);
  });

  it("tell with no first mate says so", async () => {
    const { cli, threads } = await setup();
    threads.archiveNow("thr_mate");
    const result = await cli.run(["tell", "hello"], { threadId: "thr_elsewhere" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No first mate aboard");
    expect(threads.sent).toEqual([]);
  });
});

describe("help", () => {
  it("declares its commands and answers --help itself", async () => {
    const { cli } = await setup();
    expect(cli.name).toBe("firstmate");
    expect(cli.commands?.map((command) => command.name)).toEqual(["crew-spawn", "tell"]);
    const help = await cli.run(["crew", "spawn", "--help"], {});
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--prompt-file");
  });
});
