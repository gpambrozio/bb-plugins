/**
 * The wrapper is run for real under /bin/sh: what it prints, where it runs the command, the exit
 * code it ends with, and the marker the server looks for. The user's shell is run for real too, in a
 * pseudo-terminal (`testing/run_in_pty.py`), with each shell this machine has.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASH_STARTUP,
  FINISHED_MARKER,
  FISH_BEFORE_COMMAND,
  SH_BEFORE_COMMAND,
  SH_STARTUP,
  ZSH_BEFORE_COMMAND,
  ZSH_STARTUP,
  actionArgv,
  hasFinished,
  isWindowsPath,
  relativeFolder,
} from "./command";

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
    expect(argv.slice(3, 8)).toEqual(["bb-project-actions", "/work/repo", "./web", "npm run dev", "Dev server"]);
    expect(argv.slice(8)).toEqual([ZSH_STARTUP, BASH_STARTUP, SH_STARTUP, ZSH_BEFORE_COMMAND, SH_BEFORE_COMMAND, FISH_BEFORE_COMMAND]);
    expect(argv[2]).toContain("shell=${SHELL:-/bin/sh}");
    expect(argv[2]).toContain('ZDOTDIR=$startup "$shell" -i -l -c "$8$3" ;;');
    expect(argv[2]).toContain('"$shell" --rcfile "$startup/bashrc" -i -c "$9$3" ;;');
    expect(argv[2]).toContain('ENV=$startup/env "$shell" -i -c "$9$3" ;;');
    expect(argv[2]).toContain('fish) rm -rf "$startup"; "$shell" -l -c "${10}$3" ;;');
    expect(argv[2]).toContain('*) rm -rf "$startup"; "$shell" -l -c "$3" ;;');
  });

  it("guards Ctrl+C before the startup files, and job control, Ctrl+C and the folder after them", () => {
    for (const startup of [ZSH_STARTUP, BASH_STARTUP, SH_STARTUP]) {
      expect(startup.split("\n").slice(0, 2)).toEqual(["trap 'exit 130' INT", 'command rm -rf -- "$BB_PROJECT_ACTIONS_STARTUP"']);
    }
    expect(SH_BEFORE_COMMAND).toMatch(/^set \+m; trap 'exit 130' INT; \\command \\cd -- "\$BB_PROJECT_ACTION_DIR" && /);
    expect(ZSH_BEFORE_COMMAND).toMatch(/^set \+m; trap 'exit 130' INT; \\builtin cd -q -- "\$BB_PROJECT_ACTION_DIR" && /);
    expect(FISH_BEFORE_COMMAND).toMatch(/^builtin cd -- \$BB_PROJECT_ACTION_DIR; /);
    for (const prefix of [SH_BEFORE_COMMAND, ZSH_BEFORE_COMMAND, FISH_BEFORE_COMMAND]) expect(prefix).not.toContain("\n");
  });

  it("falls back to /bin/sh when SHELL is not set", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const [file, ...args] = actionArgv(root, action({ command: "echo ran", name: "Plain" }));
    const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.stdout).toContain("ran\n");
    expect(result.stdout).toContain("[Plain ended with exit code 0.");
    expect(result.status).toBe(0);
  });

  // dash's error messages name the line; bash 3.2 (macOS's /bin/sh) miscounts under `-c` whatever comes
  // first, and Ubuntu's dash leaves `$LINENO` empty in an interactive shell.
  it.skipIf(which("dash") === null)("keeps the command's line numbers its own after the sh family's prefix", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const [file, ...args] = actionArgv(root, action({ command: "true\nno-such-command-here" }));
    const result = spawnSync(file!, args, { input: "\n", encoding: "utf8", env: { PATH: process.env.PATH, SHELL: which("dash")! } });
    expect(result.stderr).toMatch(/: 2: no-such-command-here: not found/);
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

/** Lines added to the end of the startup files of `homeWithRcFiles`. */
interface ExtraStartup {
  /** For every shell; written in syntax fish shares. */
  all?: string;
  /** For zsh only. */
  zsh?: string;
  /** For bash and the `sh` family. */
  sh?: string;
}

/**
 * A home folder whose rc files each set FROM_RC and put `rcbin` (with an `rc-tool` in it) first on the
 * PATH, but only in an interactive shell, as `.bashrc` files usually do, so a login shell alone sees
 * neither. fish reads `config.fish` in every mode, and runs as a login shell, so its file sets both
 * outside an interactive check.
 */
function homeWithRcFiles(extra: ExtraStartup = {}): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-home-")));
  const tail = (...lines: (string | undefined)[]) => lines.filter((line) => line !== undefined).map((line) => `${line}\n`).join("");
  const interactiveOnly = (name: string) => `case $- in *i*) export FROM_RC=${name}; export PATH="$HOME/rcbin:$PATH" ;; esac\n${tail(extra.sh, extra.all)}`;
  writeFileSync(join(home, ".zshrc"), `export FROM_RC=zshrc\nexport PATH="$HOME/rcbin:$PATH"\n${tail(extra.zsh, extra.all)}`);
  writeFileSync(join(home, ".bash_profile"), '. "$HOME/.bashrc"\n');
  writeFileSync(join(home, ".bashrc"), interactiveOnly("bashrc"));
  writeFileSync(join(home, ".profile"), 'ENV="$HOME/.shrc"; export ENV\n');
  writeFileSync(join(home, ".shrc"), interactiveOnly("shrc"));
  mkdirSync(join(home, ".config", "fish"), { recursive: true });
  writeFileSync(join(home, ".config", "fish", "config.fish"), `set -gx FROM_RC fish\nset -gx PATH $HOME/rcbin $PATH\n${tail(extra.all)}`);
  mkdirSync(join(home, "rcbin"));
  writeFileSync(join(home, "rcbin", "rc-tool"), "#!/bin/sh\necho rc-tool-ran\n");
  chmodSync(join(home, "rcbin", "rc-tool"), 0o755);
  return home;
}

/**
 * Each shell the wrapper knows, with the rc file `homeWithRcFiles` gives it: `sh` and `ksh` read `.profile`
 * and then the `ENV` it sets. fish has no file to read before `config.fish`, and when a Ctrl+C there stops
 * it, it ends with 0, not 130.
 */
const shells = [
  { name: "zsh", rc: "zshrc", startupInterruptCode: 130 },
  { name: "bash", rc: "bashrc", startupInterruptCode: 130 },
  { name: "sh", rc: "shrc", startupInterruptCode: 130 },
  { name: "dash", rc: "shrc", startupInterruptCode: 130 },
  { name: "ksh", rc: "shrc", startupInterruptCode: 130 },
  { name: "fish", rc: "fish", startupInterruptCode: null },
].map((shell) => ({ ...shell, path: which(shell.name) }));

describe.each(shells)("in a terminal, with $name as the user's shell", ({ name, rc, startupInterruptCode, path }) => {
  const available = python !== null && path !== null;
  const env = (home: string) => ({ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: path!, TERM: "xterm-256color" });
  const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));

  it.skipIf(!available)("loads the shell's interactive startup files, as a terminal the user opens does", () => {
    const home = homeWithRcFiles();
    const result = runInPty(actionArgv(workspace(), action({ command: 'echo "rc=$FROM_RC"; rc-tool' })), env(home));
    expect(result.output).toContain(`rc=${rc}\r\n`);
    expect(result.output).toContain("rc-tool-ran");
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

  it.skipIf(!available)("leaves no startup folder behind once the command is running, nor after", () => {
    const home = homeWithRcFiles();
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-tmp-")));
    // bb can end the wrapper while the command runs (the terminal is closed), so the folder must be gone by then.
    const result = runInPty(actionArgv(workspace(), action({ command: 'echo "left: $(ls -A "$TMPDIR")."', name: "Tidy" })), { ...env(home), TMPDIR: temporary });
    expect(result.output).toContain("left: .\r\n");
    expect(result.waited_for_enter).toBe(true);
    expect(readdirSync(temporary)).toEqual([]);
  }, 30_000);

  it.skipIf(!available)("runs in the action's folder even when a startup file changes folder", () => {
    const home = homeWithRcFiles({ all: 'cd "$HOME"' });
    const root = workspace();
    mkdirSync(join(root, "web"));
    const result = runInPty(actionArgv(root, action({ command: "pwd -P", cwd: "web", name: "Where" })), env(home));
    expect(result.output).toContain(`${join(root, "web")}\r\n`);
    expect(result.output).not.toContain(`${home}\r\n`);
    expect(result.output).toContain("[Where ended with exit code 0.");
    expect(result.waited_for_enter).toBe(true);
  }, 30_000);

  it.skipIf(!available || name === "fish")("goes back to the folder when a startup file aliases cd to a function", () => {
    const jump = 'jump() { command \\cd "$@"; }; alias cd=jump';
    const home = homeWithRcFiles({ zsh: jump, sh: jump });
    const root = workspace();
    mkdirSync(join(root, "web"));
    const result = runInPty(actionArgv(root, action({ command: "pwd -P", cwd: "web", name: "Alias" })), env(home));
    expect(result.output).toContain(`${join(root, "web")}\r\n`);
    expect(result.output).toContain("[Alias ended with exit code 0.");
  }, 30_000);

  // The `sh` family expands `ENV` before reading the file it names, set in `.profile` or inherited.
  it.skipIf(!available || !["sh", "dash", "ksh"].includes(name))("reads the file an ENV with parameters in it names", () => {
    for (const where of ["profile", "inherited"] as const) {
      const home = homeWithRcFiles();
      const unexpanded = "$HOME/.shrc";
      writeFileSync(join(home, ".profile"), where === "profile" ? `ENV='${unexpanded}'; export ENV\n` : "");
      const result = runInPty(actionArgv(workspace(), action({ command: 'echo "rc=$FROM_RC"' })), where === "profile" ? env(home) : { ...env(home), ENV: unexpanded });
      expect(result.output, where).toContain("rc=shrc\r\n");
    }
  }, 30_000);

  it.skipIf(!available)("never runs outside the workspace when a startup file swaps the folder for a link out of it", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "project-actions-")));
    const root = join(base, "repo");
    mkdirSync(join(root, "web"), { recursive: true });
    mkdirSync(join(base, "outside"));
    const home = homeWithRcFiles({ all: `mv "${join(root, "web")}" "${join(root, "web-old")}"; ln -s "${join(base, "outside")}" "${join(root, "web")}"` });
    const result = runInPty(actionArgv(root, action({ command: "pwd -P", cwd: "web", name: "Swap" })), env(home));
    expect(result.output).not.toContain(`${join(base, "outside")}\r\n`);
    // Refused, or (ksh, whose `cd` to the folder it is in does nothing) run in the folder it checked, now web-old.
    expect(result.output).toMatch(/its folder could not be entered again after the shell started|\/repo\/web-old\r\n/);
    expect(result.finished).toBe(true);
    expect(result.waited_for_enter).toBe(true);
  }, 30_000);

  // fish's `read` is its own line editor: a Ctrl+C there cancels the prompt and `config.fish` goes on, as
  // in a terminal, and fish reads no file of ours before `config.fish` that could stop it.
  for (const [what, line, fishToo] of [
    ["a slow startup file", "echo rc-start; sleep 30", true],
    ["a startup file waiting for input", "echo rc-start; read answer", false],
  ] as const) {
    it.skipIf(!available || (name === "fish" && !fishToo))(`does not run the command after a Ctrl+C in ${what}, and waits for Enter`, () => {
      const home = homeWithRcFiles({ all: line });
      const result = runInPty(actionArgv(workspace(), action({ command: "echo should-not-run", name: "Early" })), env(home), "rc-start");
      expect(result.output).not.toContain("should-not-run");
      expect(result.finished).toBe(true);
      expect(result.waited_for_enter).toBe(true);
      if (startupInterruptCode !== null) {
        expect(result.output).toContain(`[Early ended with exit code ${startupInterruptCode}.`);
        expect(result.exit_code).toBe(startupInterruptCode);
      }
    }, 30_000);
  }

  // fish turns job control on and off by itself; a fish startup file has no `set -m`.
  it.skipIf(!available || name === "fish")("keeps the terminal when a startup file turns job control on", () => {
    const home = homeWithRcFiles({ zsh: "setopt monitor", sh: "set -m" });
    for (const command of ["sleep 0.1", "exec sleep 0.1"]) {
      const result = runInPty(actionArgv(workspace(), action({ command, name: "Monitor" })), env(home));
      expect(result.output, command).toContain("[Monitor ended with exit code 0.");
      expect(result.waited_for_enter, command).toBe(true);
      expect(result.exit_code, command).toBe(0);
    }
    const interrupted = runInPty(actionArgv(workspace(), action({ command: "echo started\nsleep 30\necho should-not-run", name: "Monitor" })), env(home), "started");
    expect(interrupted.output).not.toContain("should-not-run");
    expect(interrupted.output).toContain("[Monitor ended with exit code 130.");
    expect(interrupted.waited_for_enter).toBe(true);
    expect(interrupted.exit_code).toBe(130);
  }, 30_000);
});
