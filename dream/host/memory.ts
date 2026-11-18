/**
 * Which folder holds a repository's Claude Code auto memory, resolved as Claude Code 2.1.326 does it
 * (`Yf.resolveEntry`, `nS` and `Vf` in its bundle), seen from the repository's main checkout:
 *
 * 1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, taken as written (no `~` expansion);
 * 2. the first `autoMemoryDirectory` set in policy, flag, local, project and then user settings, with a
 *    leading `~/` expanded to the home folder. The first source that sets the key decides, even when
 *    its value is unusable (a relative path, say), in which case the default applies;
 * 3. `<config>/projects/<slug of the canonical git root>/memory/`, where `<config>` is
 *    `CLAUDE_CODE_REMOTE_MEMORY_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. For a git worktree the
 *    canonical root is the main checkout, so every worktree shares one folder.
 *
 * Claude Code reads local and project settings only in a trusted workspace; a repository with
 * sessions has been trusted, and bb's sessions are non-interactive, which counts as trusted. Policy
 * settings are read from the `managed-settings.json` file and its `managed-settings.d/` drop-ins;
 * MDM and server-managed policy are not visible here. Flag settings (`--settings`) belong to one
 * launch and are not modelled.
 *
 * Nothing here writes. Two things are reported and never touched: a legacy default folder that still
 * holds `.md` files beside a custom one, and an `autoMemoryDirectory` set only in
 * `settings.local.json`, which a worktree of the repository does not have, so its sessions use
 * another folder.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { projectSlug } from "./slug";

export type MemorySource = "env" | "policySettings" | "localSettings" | "projectSettings" | "userSettings" | "default";

/** Settings sources in the order Claude Code consults them for `autoMemoryDirectory` (flag settings left out). */
const SETTINGS_ORDER = ["policySettings", "localSettings", "projectSettings", "userSettings"] as const;
type SettingsSource = (typeof SETTINGS_ORDER)[number];

export interface MemoryEnvironment {
  CLAUDE_COWORK_MEMORY_PATH_OVERRIDE?: string;
  CLAUDE_CONFIG_DIR?: string;
  CLAUDE_CODE_REMOTE_MEMORY_DIR?: string;
  CLAUDE_CODE_DISABLE_AUTO_MEMORY?: string;
  /** Both turn off the hooks a dream's guard is (`hookBlockers`). */
  CLAUDE_CODE_PERSONAL_HOOKS_OFF?: string;
  CLAUDE_CODE_SIMPLE?: string;
}

export interface ResolveMemoryOptions {
  /** The repository's main checkout on this machine. */
  checkout: string;
  home: string;
  env: MemoryEnvironment;
  /** Folders that may hold `managed-settings.json` and `managed-settings.d/`. */
  managedDirs: readonly string[];
}

export interface ResolvedMemory {
  /** The memory folder, absolute, without a trailing separator. */
  dir: string;
  source: MemorySource;
  /** The value as written in the setting or variable that chose `dir`, when one did. */
  configured: string | null;
  /** The folder Claude Code would use with no override. */
  defaultDir: string;
  /** False when the settings or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` turn auto memory off. */
  autoMemoryEnabled: boolean;
  /** Things the user should know about, in plain sentences. Never acted on. */
  warnings: string[];
}

/** Every variable `resolveMemory` and `hookBlockers` read, taken from a process environment. */
export const ENVIRONMENT_KEYS = [
  "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_PERSONAL_HOOKS_OFF",
  "CLAUDE_CODE_SIMPLE",
] as const satisfies ReadonlyArray<keyof MemoryEnvironment>;

export function hostEnvironment(env: NodeJS.ProcessEnv): MemoryEnvironment {
  const result: MemoryEnvironment = {};
  for (const key of ENVIRONMENT_KEYS) if (env[key] !== undefined) result[key] = env[key];
  return result;
}

export function claudeConfigDir(home: string, env: MemoryEnvironment): string {
  return nonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude");
}

/** Where policy settings files live on this platform. */
export function managedSettingsDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode"];
  if (platform === "win32") return ["C:\\Program Files\\ClaudeCode"];
  return ["/etc/claude-code"];
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * Claude Code's `Vf`: a usable memory folder from a configured value, or undefined. With
 * `expandTilde`, a leading `~/` is the home folder, and a value that climbs out of it is refused.
 */
export function usableDir(value: string | undefined, expandTilde: boolean, home: string): string | undefined {
  if (!value) return undefined;
  let candidate = value;
  if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
    const rest = candidate.slice(2);
    const normalized = path.normalize(rest || ".");
    if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.startsWith("../")) {
      return undefined;
    }
    candidate = path.join(home, rest);
  }
  const normalized = path.normalize(candidate).replace(/[/\\]+$/, "");
  if (!path.isAbsolute(normalized) || normalized.length < 3 || /^[A-Za-z]:$/.test(normalized) || normalized.includes("\0")) {
    return undefined;
  }
  return normalized;
}

export interface SettingsFile {
  file: string;
  values: Record<string, unknown> | null;
  error: string | null;
}

export function readSettingsFile(file: string): SettingsFile {
  if (!existsSync(file)) return { file, values: null, error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { file, values: null, error: `${file} is not a JSON object` };
    }
    return { file, values: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return { file, values: null, error: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function policyFiles(managedDirs: readonly string[]): SettingsFile[] {
  const files: SettingsFile[] = [];
  for (const dir of managedDirs) {
    // Drop-ins later in the alphabet win over earlier ones and over the base file.
    const dropIns = path.join(dir, "managed-settings.d");
    if (existsSync(dropIns)) {
      try {
        const names = readdirSync(dropIns).filter((name) => name.endsWith(".json")).sort().reverse();
        for (const name of names) files.push(readSettingsFile(path.join(dropIns, name)));
      } catch {
        // An unreadable drop-in folder is a policy Claude Code could not read either.
      }
    }
    files.push(readSettingsFile(path.join(dir, "managed-settings.json")));
  }
  return files;
}

/** Each settings source's files, highest priority first within a source. */
export function settingsFiles(options: ResolveMemoryOptions): Record<SettingsSource, SettingsFile[]> {
  const configDir = claudeConfigDir(options.home, options.env);
  return {
    policySettings: policyFiles(options.managedDirs),
    localSettings: [readSettingsFile(path.join(options.checkout, ".claude", "settings.local.json"))],
    projectSettings: [readSettingsFile(path.join(options.checkout, ".claude", "settings.json"))],
    userSettings: [readSettingsFile(path.join(configDir, "settings.json"))],
  };
}

function firstSet(
  files: Record<SettingsSource, SettingsFile[]>,
  key: string,
  sources: readonly SettingsSource[],
): { source: SettingsSource; value: unknown } | null {
  for (const source of sources) {
    for (const file of files[source]) {
      const value = file.values?.[key];
      if (value !== undefined && value !== null) return { source, value };
    }
  }
  return null;
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isFalse(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * The canonical git root of `dir`: the main checkout for a worktree, `dir`'s repository root for a
 * plain checkout, or null outside git. Follows a `.git` file's `gitdir:` and its `commondir`, as
 * `git rev-parse --git-common-dir` does, without running git.
 */
export function canonicalGitRoot(dir: string): string | null {
  let current: string;
  try {
    current = realpathSync(dir);
  } catch {
    current = path.resolve(dir);
  }
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stats;
    try {
      stats = statSync(dotGit);
    } catch {
      stats = null;
    }
    if (stats?.isDirectory()) return current;
    if (stats?.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!match) return current;
      const gitDir = path.resolve(current, match[1].trim());
      const commonFile = path.join(gitDir, "commondir");
      if (!existsSync(commonFile)) return current;
      const commonDir = path.resolve(gitDir, readFileSync(commonFile, "utf8").trim());
      const root = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The `.md` files in a folder, recursively, outside `.git`. Zero for a folder that does not exist. */
export function countMarkdown(dir: string): number {
  let count = 0;
  const walk = (folder: string) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(path.join(folder, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        count += 1;
      }
    }
  };
  walk(dir);
  return count;
}

function defaultMemoryDir(options: ResolveMemoryOptions): string {
  const base = nonEmpty(options.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) ?? claudeConfigDir(options.home, options.env);
  const root = canonicalGitRoot(options.checkout) ?? path.resolve(options.checkout);
  return path.join(base, "projects", projectSlug(root), "memory");
}

function resolveWith(
  options: ResolveMemoryOptions,
  files: Record<SettingsSource, SettingsFile[]>,
  sources: readonly SettingsSource[],
): { dir: string; source: MemorySource; configured: string | null } {
  const override = nonEmpty(options.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE);
  const fromEnv = usableDir(override, false, options.home);
  if (fromEnv) return { dir: fromEnv, source: "env", configured: override ?? null };
  const set = firstSet(files, "autoMemoryDirectory", sources);
  if (set && typeof set.value === "string") {
    const dir = usableDir(set.value, true, options.home);
    if (dir) return { dir, source: set.source, configured: set.value };
  }
  return { dir: defaultMemoryDir(options), source: "default", configured: null };
}

export function resolveMemory(options: ResolveMemoryOptions): ResolvedMemory {
  const files = settingsFiles(options);
  const warnings: string[] = [];
  for (const file of Object.values(files).flat()) if (file.error) warnings.push(file.error);

  const resolved = resolveWith(options, files, SETTINGS_ORDER);
  const defaultDir = defaultMemoryDir(options);

  const set = firstSet(files, "autoMemoryDirectory", SETTINGS_ORDER);
  if (resolved.source === "default" && set && typeof set.value === "string") {
    warnings.push(`autoMemoryDirectory "${set.value}" in ${set.source} is not a usable folder, so Claude Code uses the default one.`);
  }

  if (resolved.source === "localSettings") {
    // A worktree checks out tracked files only, so it has no settings.local.json.
    const inWorktree = resolveWith(options, files, ["policySettings", "projectSettings", "userSettings"]);
    if (inWorktree.dir !== resolved.dir) {
      warnings.push(
        `autoMemoryDirectory is set only in .claude/settings.local.json, so sessions in this repository's worktrees use ${inWorktree.dir} instead of ${resolved.dir}.`,
      );
    }
  }

  if (path.resolve(resolved.dir) !== path.resolve(defaultDir)) {
    const legacy = countMarkdown(defaultDir);
    if (legacy > 0) {
      warnings.push(`The default memory folder ${defaultDir} still holds ${legacy} .md file${legacy === 1 ? "" : "s"}; Claude Code no longer reads it for this repository. Dream leaves it alone.`);
    }
  }

  let autoMemoryEnabled = true;
  const disable = options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (isTrue(disable)) autoMemoryEnabled = false;
  else if (!isFalse(disable)) {
    const enabled = firstSet(files, "autoMemoryEnabled", SETTINGS_ORDER);
    if (enabled && enabled.value === false) autoMemoryEnabled = false;
  }

  return { ...resolved, defaultDir, autoMemoryEnabled, warnings };
}

/**
 * Why a dream's guard hook would not run on this machine, as far as files and the environment show:
 * `disableAllHooks` in user or managed settings (Claude Code merges it restrictively, so the
 * workspace's own `false` cannot undo it), managed `allowManagedHooksOnly` (which drops project
 * hooks), `CLAUDE_CODE_PERSONAL_HOOKS_OFF` or `CLAUDE_CODE_SIMPLE`, or a settings file Claude Code
 * could not read either. MDM and server-managed policy are not visible here; the startup canary
 * catches those. Empty when nothing is in the way.
 */
export function hookBlockers(options: Pick<ResolveMemoryOptions, "home" | "env" | "managedDirs">): string[] {
  const reasons: string[] = [];
  const user = readSettingsFile(path.join(claudeConfigDir(options.home, options.env), "settings.json"));
  const managed = policyFiles(options.managedDirs);
  for (const file of [user, ...managed]) {
    if (file.error) reasons.push(`${file.error}, so whether it turns hooks off cannot be known`);
    if (file.values?.disableAllHooks === true) reasons.push(`${file.file} sets disableAllHooks`);
  }
  for (const file of managed) {
    if (file.values?.allowManagedHooksOnly === true) reasons.push(`${file.file} sets allowManagedHooksOnly, which ignores project hooks`);
  }
  if (isTrue(options.env.CLAUDE_CODE_PERSONAL_HOOKS_OFF)) reasons.push("CLAUDE_CODE_PERSONAL_HOOKS_OFF is set");
  if (nonEmpty(options.env.CLAUDE_CODE_SIMPLE) && !isFalse(options.env.CLAUDE_CODE_SIMPLE)) reasons.push("CLAUDE_CODE_SIMPLE is set");
  return reasons;
}
