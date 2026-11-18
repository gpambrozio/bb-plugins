/**
 * A dream thread's working directory, which is what holds the dream to native auto-dream's tool
 * limits inside a bb thread. bb's Claude Code provider starts every session with the user, project
 * and local settings sources, and its least privileged permission mode is accept-edits, with no tool
 * allowlist and no dontAsk. So the dream does not run in the project's checkout: it runs here, and
 * this folder's `.claude/settings.json`, which Claude Code loads as the session's project settings,
 * carries
 *
 * - a PreToolUse hook on every tool that runs `guard.mjs`, which answers allow or deny and never
 *   ask, as native's dontAsk dream does (see guard/guard.mjs for the limits). It is declared
 *   `onFailure: "block"`, so a guard that cannot start, crashes or times out blocks the call instead
 *   of handing it to Claude Code's own permission check;
 * - a companion hook on Write that fails on the run's canary file, which proves before the dream
 *   prompt is sent that this Claude Code honours `onFailure` (see `checkCanary` in host/dreams.ts);
 * - `disableAllHooks: false`. A `true` anywhere else still wins (the key is restrictive), which is why
 *   `prepare` refuses when it can see one and the canary catches what it cannot see;
 * - `autoMemoryDirectory` set to `startup-memory/`, an empty folder of the workspace, for the whole
 *   session. Claude Code loads a session's memory index into its context at start, before any hook
 *   runs, so pointing it at the real memory would put untrusted text in front of the agent before the
 *   guard is proven. The dream reads the memory with tools, under the guard, once it is armed;
 * - an Edit allow rule and an additional directory for that folder, so the sandbox bb runs Bash in
 *   lets `rm -f` of a memory file through.
 *
 * Its transcripts land in this folder's own `~/.claude/projects/<slug>` folder, which belongs to no
 * project, so a dream never counts as one of its repository's sessions.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WorkspaceOptions {
  dir: string;
  /** The folder the dream may write once the startup check passes, as a real path. */
  memoryDir: string;
  /** Where the guard logs its decisions, outside the workspace and the memory. */
  logPath: string;
  guardPath: string;
  /** The Node that runs the guard: the host daemon's own. */
  nodePath: string;
  /** Set when that Node is Electron's, which runs as Node only with ELECTRON_RUN_AS_NODE. */
  electron: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function guardCommand(options: Pick<WorkspaceOptions, "nodePath" | "electron" | "guardPath">, policyPath: string, canaryFail = false): string {
  const node = `${options.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shellQuote(options.nodePath)}`;
  return `${node} ${shellQuote(options.guardPath)}${canaryFail ? " --canary-fail" : ""} ${shellQuote(policyPath)}`;
}

/** The file the startup check asks the thread to write; the hooks must keep it from existing. */
export const CANARY_FILE = ".dream-canary.md";

/** Claude Code's spelling of an absolute path in a permission rule: `//` and the path. */
function ruleSpelling(absolute: string): string {
  return `/${absolute.replace(/\\/g, "/")}`;
}

/** The empty folder a dream session's auto memory points at. */
export const STARTUP_MEMORY = "startup-memory";

export function workspaceSettings(options: WorkspaceOptions, policyPath: string): Record<string, unknown> {
  return {
    disableAllHooks: false,
    autoMemoryDirectory: path.join(options.dir, STARTUP_MEMORY),
    permissions: {
      allow: [`Edit(${ruleSpelling(options.memoryDir)}/**)`],
      additionalDirectories: [options.memoryDir],
    },
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: guardCommand(options, policyPath), timeout: 30, onFailure: "block" }] },
        { matcher: "Write", hooks: [{ type: "command", command: guardCommand(options, policyPath, true), timeout: 30, onFailure: "block" }] },
      ],
    },
  };
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

export interface GuardPolicy {
  memoryDir: string;
  logPath: string;
  canary: string;
}

export function writePolicy(policyPath: string, policy: GuardPolicy): void {
  writeAtomic(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
}

/** Lets the guard allow writes in the dream's real target: only after the startup check passed. */
export function armPolicy(workspace: string, memoryDir: string): void {
  const policyPath = path.join(workspace, "policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as GuardPolicy;
  writePolicy(policyPath, { ...policy, memoryDir });
}

/** Writes the guard and a fresh workspace for one dream; answers the workspace path. */
export function writeWorkspace(options: WorkspaceOptions, guardSource: string): string {
  rmSync(options.dir, { recursive: true, force: true });
  mkdirSync(path.join(options.dir, ".claude"), { recursive: true });
  writeAtomic(options.guardPath, guardSource);
  mkdirSync(path.join(options.dir, STARTUP_MEMORY));
  const policyPath = path.join(options.dir, "policy.json");
  const canary = path.join(realpathSync(options.dir), CANARY_FILE);
  // Unarmed: until the startup check passes, the only memory the guard lets the thread write is the
  // empty startup folder. `armPolicy` points it at the real target afterwards.
  writePolicy(policyPath, { memoryDir: path.join(realpathSync(options.dir), STARTUP_MEMORY), logPath: options.logPath, canary });
  writeAtomic(path.join(options.dir, ".claude", "settings.json"), `${JSON.stringify(workspaceSettings(options, policyPath), null, 2)}\n`);
  writeAtomic(
    path.join(options.dir, "README.md"),
    "This folder is a Dream plugin workspace: a dream thread runs here so that the settings beside it hold it to memory-only writes. The plugin rewrites it for every dream.\n",
  );
  return options.dir;
}
