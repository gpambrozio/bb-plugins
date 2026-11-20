/**
 * The wrapper is run for real under /bin/sh: what it prints, where it runs the command, the exit
 * code it ends with, and the marker the server looks for.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FINISHED_MARKER, actionArgv, hasFinished, isWindowsPath, relativeFolder } from "./command";

const action = (fields: { command: string; cwd?: string | null; name?: string }) => ({ name: fields.name ?? "Test", command: fields.command, cwd: fields.cwd ?? null, description: null });

/** Runs the argv as bb's terminal would, with /bin/sh as the user's shell and Enter on stdin. */
function run(argv: string[]) {
  const [file, ...args] = argv;
  const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH, SHELL: "/bin/sh", HOME: process.env.HOME } });
  return { stdout: result.stdout, status: result.status };
}

describe("actionArgv", () => {
  it("runs the command through the user's login shell under /bin/sh, the workspace and the name as arguments", () => {
    const argv = actionArgv("/work/repo", action({ command: "npm run dev", cwd: "web", name: "Dev server" }));
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(3)).toEqual(["bb-project-actions", "/work/repo", "./web", "npm run dev", "Dev server"]);
    expect(argv[2]).toContain('"${SHELL:-/bin/sh}" -lc "$3"');
  });

  it("runs in the action's folder and keeps the command's exit code", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    mkdirSync(join(root, "web"));
    const result = run(actionArgv(root, action({ command: 'pwd; echo "it\'s $((40 + 2))"; exit 3', cwd: "web", name: "Build" })));
    expect(result.stdout).toContain(`${root}/web\n`);
    expect(result.stdout).toContain("it's 42\n");
    expect(result.stdout).toContain("[Build ended with exit code 3. Press Enter to close this terminal.]");
    expect(result.stdout.endsWith(FINISHED_MARKER)).toBe(true);
    expect(result.status).toBe(3);
  });

  it("does not let the action's name or command reach the wrapper as code", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const result = run(actionArgv(root, action({ command: "echo ok", name: '%s $(echo hacked) "; exit 9' })));
    expect(result.stdout).toContain('[%s $(echo hacked) "; exit 9 ended with exit code 0.');
    expect(result.status).toBe(0);
  });

  it("says how it ended when the folder is missing, without running the command", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const result = run(actionArgv(root, action({ command: "echo should-not-run", cwd: "gone" })));
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.stdout).toContain("ended with exit code 1.");
    expect(hasFinished(result.stdout)).toBe(true);
    expect(result.status).toBe(1);
  });
});

describe("relativeFolder", () => {
  it.each([
    [null, "."],
    ["web", "./web"],
    ["packages/ui", "./packages/ui"],
  ])("%s → %s", (cwd, expected) => {
    expect(relativeFolder({ cwd })).toBe(expected);
  });
});

describe("the folder check, with symlinks resolved on the machine", () => {
  /** A workspace and a folder beside it, under a fresh temporary folder (not resolved: macOS's is a link). */
  function layout() {
    const base = mkdtempSync(join(tmpdir(), "project-actions-"));
    const workspace = join(base, "repo");
    mkdirSync(join(workspace, "web", "app"), { recursive: true });
    mkdirSync(join(base, "outside"));
    return { base, workspace };
  }

  it("refuses a folder that is a link out of the workspace, and runs nothing", () => {
    const { base, workspace } = layout();
    symlinkSync("../outside", join(workspace, "linked"));
    const result = run(actionArgv(workspace, action({ command: "echo should-not-run; pwd -P", cwd: "linked", name: "Seed" })));
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.stdout).toContain(`[Seed was not run: its folder ./linked is ${realpathSync(join(base, "outside"))}, outside the workspace ${realpathSync(workspace)}.]`);
    expect(result.stdout).toContain("[Seed ended with exit code 1.");
    expect(hasFinished(result.stdout)).toBe(true);
    expect(result.status).toBe(1);
  });

  it("refuses a link to an absolute folder elsewhere, and one deeper in the path", () => {
    const { base, workspace } = layout();
    symlinkSync(join(base, "outside"), join(workspace, "web", "escape"));
    const result = run(actionArgv(workspace, action({ command: "echo should-not-run", cwd: "web/escape" })));
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.stdout).toContain("was not run");
  });

  it("refuses a folder named like the workspace beside it", () => {
    const { base, workspace } = layout();
    mkdirSync(join(base, "repo-other"));
    symlinkSync("../repo-other", join(workspace, "sibling"));
    const result = run(actionArgv(workspace, action({ command: "echo should-not-run", cwd: "sibling" })));
    expect(result.stdout).not.toContain("should-not-run");
  });

  it("runs in a link that stays inside the workspace, at its real folder", () => {
    const { workspace } = layout();
    symlinkSync("web/app", join(workspace, "app-link"));
    const result = run(actionArgv(workspace, action({ command: "pwd -P", cwd: "app-link" })));
    expect(result.stdout).toContain(`${realpathSync(join(workspace, "web", "app"))}\n`);
    expect(result.status).toBe(0);
  });

  it("runs in a workspace reached through a link, at the workspace's root", () => {
    const { base, workspace } = layout();
    symlinkSync(workspace, join(base, "repo-link"));
    const result = run(actionArgv(join(base, "repo-link"), action({ command: "pwd -P" })));
    expect(result.stdout).toContain(`${realpathSync(workspace)}\n`);
    expect(result.status).toBe(0);
  });

  it("does not follow CDPATH", () => {
    const { base, workspace } = layout();
    mkdirSync(join(base, "outside", "web"));
    const [file, ...args] = actionArgv(workspace, action({ command: "pwd -P", cwd: "web" }));
    const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH, SHELL: "/bin/sh", CDPATH: join(base, "outside") } });
    expect(result.stdout).toContain(`${realpathSync(join(workspace, "web"))}\n`);
  });
});

describe("hasFinished", () => {
  it("finds the marker anywhere in the tail, keys typed after it included", () => {
    expect(hasFinished(`output\n[x ended]${FINISHED_MARKER}abc`)).toBe(true);
    expect(hasFinished("still serving on :5173\n")).toBe(false);
  });
});

describe("isWindowsPath", () => {
  it.each([
    ["C:\\repo", true],
    ["d:/repo", true],
    ["\\\\server\\share", true],
    ["/Users/me/repo", false],
  ])("%s → %s", (path, expected) => {
    expect(isWindowsPath(path)).toBe(expected);
  });
});
