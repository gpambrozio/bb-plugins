/**
 * A dream thread's working directory, which is what holds the dream to native auto-dream's tool
 * limits inside a bb thread. bb's Claude Code provider starts every session with the user, project
 * and local settings sources, and its least privileged permission mode is accept-edits, with no tool
 * allowlist and no dontAsk. So the dream does not run in the project's checkout: it runs here, and
 * this folder's `.claude/settings.json`, which Claude Code loads as the session's project settings,
 * carries
 *
 * - a PreToolUse hook on every tool that runs `guard.mjs`, which answers allow or deny and never
 *   ask, as native's dontAsk dream does (see guard/guard.mjs for the limits);
 * - `autoMemoryDirectory` set to the folder the dream writes (the repository's memory, or a dry
 *   run's copy), so the session's auto-memory section, which the prompt defers to for the memory
 *   format, names that folder;
 * - an Edit allow rule and an additional directory for that folder, so the sandbox bb runs Bash in
 *   lets `rm -f` of a memory file through.
 *
 * Its transcripts land in this folder's own `~/.claude/projects/<slug>` folder, which belongs to no
 * project, so a dream never counts as one of its repository's sessions.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WorkspaceOptions {
  dir: string;
  /** The folder the dream may write, as a real path. */
  memoryDir: string;
  guardPath: string;
  /** The Node that runs the guard: the host daemon's own. */
  nodePath: string;
  /** Set when that Node is Electron's, which runs as Node only with ELECTRON_RUN_AS_NODE. */
  electron: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function guardCommand(options: Pick<WorkspaceOptions, "nodePath" | "electron" | "guardPath">, policyPath: string): string {
  const node = `${options.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shellQuote(options.nodePath)}`;
  return `${node} ${shellQuote(options.guardPath)} ${shellQuote(policyPath)}`;
}

/** Claude Code's spelling of an absolute path in a permission rule: `//` and the path. */
function ruleSpelling(absolute: string): string {
  return `/${absolute.replace(/\\/g, "/")}`;
}

export function workspaceSettings(options: WorkspaceOptions, policyPath: string): Record<string, unknown> {
  return {
    autoMemoryDirectory: options.memoryDir,
    permissions: {
      allow: [`Edit(${ruleSpelling(options.memoryDir)}/**)`],
      additionalDirectories: [options.memoryDir],
    },
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCommand(options, policyPath), timeout: 30 }] }],
    },
  };
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** Writes the guard and a fresh workspace for one dream; answers the workspace path. */
export function writeWorkspace(options: WorkspaceOptions, guardSource: string): string {
  rmSync(options.dir, { recursive: true, force: true });
  mkdirSync(path.join(options.dir, ".claude"), { recursive: true });
  writeAtomic(options.guardPath, guardSource);
  const policyPath = path.join(options.dir, "policy.json");
  writeAtomic(policyPath, `${JSON.stringify({ memoryDir: options.memoryDir }, null, 2)}\n`);
  writeAtomic(path.join(options.dir, ".claude", "settings.json"), `${JSON.stringify(workspaceSettings(options, policyPath), null, 2)}\n`);
  writeAtomic(
    path.join(options.dir, "README.md"),
    "This folder is a Dream plugin workspace: a dream thread runs here so that the settings beside it hold it to memory-only writes. The plugin rewrites it for every dream.\n",
  );
  return options.dir;
}
