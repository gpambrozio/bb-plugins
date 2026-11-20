/**
 * The wrapper is run for real under /bin/sh: what it prints, where it runs the command, the exit
 * code it ends with, and the marker the server looks for.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FINISHED_MARKER, actionArgv, actionDirectory, hasFinished, isWindowsPath } from "./command";

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
    expect(argv.slice(3)).toEqual(["bb-project-actions", "/work/repo/web", "npm run dev", "Dev server"]);
    expect(argv[2]).toContain('"${SHELL:-/bin/sh}" -lc "$2"');
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

describe("actionDirectory", () => {
  it.each([
    ["/work/repo", null, "/work/repo"],
    ["/work/repo/", "web", "/work/repo/web"],
    ["/", "web", "/web"],
    ["/", null, "/"],
  ])("%s + %s → %s", (root, cwd, expected) => {
    expect(actionDirectory(root, { cwd })).toBe(expected);
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
