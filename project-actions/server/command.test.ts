/**
 * The wrapper is run for real under /bin/sh: what it prints, where it runs the command, the exit
 * code it ends with, and the marker the server looks for. The user's shell is run for real too, in a
 * pseudo-terminal (`testing/run_in_pty.py`), with each shell this machine has.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("runs the command through the user's interactive login shell under /bin/sh, the workspace and the name as arguments", () => {
    const argv = actionArgv("/work/repo", action({ command: "npm run dev", cwd: "web", name: "Dev server" }));
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(3)).toEqual(["bb-project-actions", "/work/repo", "./web", "npm run dev", "Dev server"]);
    expect(argv[2]).toContain("shell=${SHELL:-/bin/sh}");
    expect(argv[2]).toContain('zsh) "$shell" -i -l +m -c "$3" ;;');
    expect(argv[2]).toContain(`bash | sh | dash | ash | ksh | ksh93 | mksh | yash) "$shell" -i -l -c "set +m; trap 'exit 130' INT; $3" ;;`);
    expect(argv[2]).toContain('*) "$shell" -i -l -c "$3" ;;');
  });

  it("falls back to /bin/sh when SHELL is not set", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const [file, ...args] = actionArgv(root, action({ command: "echo ran", name: "Plain" }));
    const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.stdout).toContain("ran\n");
    expect(result.stdout).toContain("[Plain ended with exit code 0.");
    expect(result.status).toBe(0);
  });

  // dash, because bash 3.2 (macOS's /bin/sh) miscounts `$LINENO` under `-c` whatever comes first.
  it.skipIf(which("dash") === null)("keeps the command's line numbers its own after the sh family's prefix", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const [file, ...args] = actionArgv(root, action({ command: 'true\necho "line $LINENO"' }));
    const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH, SHELL: which("dash")! } });
    expect(result.stdout).toContain("line 2\n");
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

/** Where a shell is installed on this machine, or null. */
function which(name: string): string | null {
  const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "which", name], { encoding: "utf8" });
  const path = result.stdout.trim();
  return result.status === 0 && path.startsWith("/") ? path : null;
}

const python = which("python3");
const ptyDriver = fileURLToPath(new URL("../testing/run_in_pty.py", import.meta.url));

interface PtyResult {
  output: string;
  finished: boolean;
  waited_for_enter: boolean;
  exit_code: number | null;
}

/** Runs the argv in a pseudo-terminal, as bb's terminal does, Ctrl+C once `interruptAfter` is printed. */
function runInPty(argv: string[], env: Record<string, string>, interruptAfter: string | null = null): PtyResult {
  const result = spawnSync(python!, ["-I", ptyDriver, JSON.stringify({ argv, env, interrupt_after: interruptAfter })], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`run_in_pty.py failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout) as PtyResult;
}

/**
 * A home folder whose rc files each set FROM_RC and put `rcbin` (with an `rc-tool` in it) first on the
 * PATH, but only in an interactive shell, as `.bashrc` files usually do, so a login shell alone sees
 * neither.
 */
function homeWithRcFiles(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-home-")));
  const interactiveOnly = (name: string) => `case $- in *i*) export FROM_RC=${name}; export PATH="$HOME/rcbin:$PATH" ;; esac\n`;
  writeFileSync(join(home, ".zshrc"), 'export FROM_RC=zshrc\nexport PATH="$HOME/rcbin:$PATH"\n');
  writeFileSync(join(home, ".bash_profile"), '. "$HOME/.bashrc"\n');
  writeFileSync(join(home, ".bashrc"), interactiveOnly("bashrc"));
  writeFileSync(join(home, ".profile"), 'ENV="$HOME/.shrc"; export ENV\n');
  writeFileSync(join(home, ".shrc"), interactiveOnly("shrc"));
  writeFileSync(join(home, ".kshrc"), interactiveOnly("kshrc"));
  mkdirSync(join(home, ".config", "fish"), { recursive: true });
  writeFileSync(join(home, ".config", "fish", "config.fish"), "if status is-interactive\n  set -gx FROM_RC fish\n  set -gx PATH $HOME/rcbin $PATH\nend\n");
  mkdirSync(join(home, "rcbin"));
  writeFileSync(join(home, "rcbin", "rc-tool"), "#!/bin/sh\necho rc-tool-ran\n");
  chmodSync(join(home, "rcbin", "rc-tool"), 0o755);
  return home;
}

/** Each shell the wrapper knows, with the rc file `homeWithRcFiles` gives it. */
const shells = [
  { name: "zsh", rc: "zshrc" },
  { name: "bash", rc: "bashrc" },
  { name: "sh", rc: null },
  { name: "dash", rc: "shrc" },
  { name: "ksh", rc: null },
  { name: "fish", rc: "fish" },
].map((shell) => ({ ...shell, path: which(shell.name) }));

describe.each(shells)("in a terminal, with $name as the user's shell", ({ name, rc, path }) => {
  const available = python !== null && path !== null;
  const env = (home: string) => ({ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: path!, TERM: "xterm-256color" });
  const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));

  it.skipIf(!available)("loads the shell's interactive startup files, as a terminal the user opens does", () => {
    const home = homeWithRcFiles();
    const result = runInPty(actionArgv(workspace(), action({ command: 'echo "rc=$FROM_RC"; rc-tool' })), env(home));
    // `sh` and `ksh` are other shells' modes on some machines (bash, mksh) and read different files;
    // what they must do is run, interactively, and finish.
    if (rc !== null) {
      expect(result.output).toContain(`rc=${rc}\r\n`);
      expect(result.output).toContain("rc-tool-ran");
    }
    expect(result.finished).toBe(true);
    expect(result.waited_for_enter).toBe(true);
  }, 30_000);

  it.skipIf(!available)("still waits for Enter when the shell hands the command's last program the terminal", () => {
    const home = homeWithRcFiles();
    for (const command of ["sleep 0.1", "exec sleep 0.1"]) {
      const result = runInPty(actionArgv(workspace(), action({ command, name: "Last" })), env(home));
      expect(result.output, command).toContain("[Last ended with exit code 0. Press Enter to close this terminal.]");
      expect(result.waited_for_enter, command).toBe(true);
      expect(result.exit_code, command).toBe(0);
    }
  }, 30_000);

  it.skipIf(!available)("ends the whole command on Ctrl+C, says so, and waits for Enter", () => {
    const home = homeWithRcFiles();
    const result = runInPty(actionArgv(workspace(), action({ command: "echo started\nsleep 30\necho should-not-run", name: "Serve" })), env(home), "started");
    expect(result.output).not.toContain("should-not-run");
    expect(result.output).toContain("[Serve ended with exit code 130. Press Enter to close this terminal.]");
    expect(result.finished).toBe(true);
    expect(result.waited_for_enter).toBe(true);
    expect(result.exit_code).toBe(130);
  }, 30_000);
});
