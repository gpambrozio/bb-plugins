import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  describeCron,
  describeEntries,
  describeInterval,
  formatCron,
  fromCalendarEntries,
  parseCron,
  toCalendarEntries,
  type CalendarEntry,
} from "../shared/cron";
import type { FailingJob, Job, JobList, JobSpec, LogChunk, RunRecord, Schedule } from "../shared/jobs";

/**
 * The host half: every `launchctl` and `plutil` call, the plist files, the
 * runner script, and the log and history files. launchd is the scheduler and
 * the store — this module keeps no state of its own beyond two small files, a
 * map of slugs to display names and the failures the user has seen.
 *
 * Everything runs on the **Mac whose jobs these are**, inside the host entry
 * bb starts on that machine. That is where the LaunchAgents live and where the
 * jobs fire, whether or not bb is open.
 *
 * Every job names its own data directory in its plist (`DIR_VARIABLE`), and
 * its runner, log and history are read from there. That is how jobs the Paseo
 * plugin made are adopted: their plists point into the Paseo plugin's
 * directory, and nothing here moves, rewrites or deletes anything in it on
 * its own account. See AGENTS.md, "Adopting the Paseo plugin's jobs".
 */

/**
 * Every job this plugin owns is a LaunchAgent whose label starts with this.
 * Listing globs for it, so nothing else in `~/Library/LaunchAgents` is ever
 * touched, and a plist someone writes by hand under the prefix shows up too.
 * It is the Paseo plugin's prefix, kept so that plugin's jobs are this one's.
 */
export const LABEL_PREFIX = "com.paseo-plugins.launchd-jobs.";

/**
 * The environment variable that tells the runner where its files are, and
 * tells this module where a job's log and history are. It keeps its Paseo
 * name because it is part of the on-disk format both plugins share.
 */
export const DIR_VARIABLE = "PASEO_LAUNCHD_JOBS_DIR";

export const RUNNER_NAME = "runner.sh";
/** How much of a log the panel gets. Older output is still in the file. */
export const LOG_TAIL_BYTES = 64 * 1024;
const RUNS_TAIL_BYTES = 64 * 1024;
const RECENT_RUNS = 20;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** How a command failed: `execFile`'s error, exit status in `code`. */
export interface CommandFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/** Runs a program and answers its stdout, or rejects with a `CommandFailure`. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export interface JobsDeps {
  /** This plugin's own data directory on this Mac: the runner, logs and history of jobs made here. */
  ownDir: string;
  launchAgentsDir: string;
  platform: NodeJS.Platform;
  /** The user whose `gui/<uid>` launchd domain the jobs live in. */
  uid: number | undefined;
  run: RunCommand;
  /** The process's own PATH, the last resort for a job's PATH. */
  envPath: string | undefined;
  warn(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failureText(error: unknown): string {
  const failure = error as CommandFailure;
  const combined = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim();
  return combined === "" ? failure.message : combined;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The runner

/**
 * What launchd actually spawns. It runs the command through a login shell,
 * writes start and exit markers around its output, appends one JSON line of
 * history, and keeps both files from growing without bound. Kept as data
 * here, rewritten on every save into this plugin's own directory, so an edit
 * to it ships with the plugin.
 *
 * A log is rotated *before* the command starts, by this script, not by
 * launchd: launchd keeps `StandardOutPath` open across the run, so a file
 * moved out from under it would go on receiving output. Only the runner's own
 * stderr goes through launchd, for the case where the runner itself fails.
 *
 * The Paseo plugin's runner writes the same log and history format, which is
 * what lets one reader serve both. Keep it that way.
 */
export const RUNNER_SCRIPT = [
  "#!/bin/zsh",
  "# Written by the launchd-jobs bb plugin; rewritten whenever a job is saved.",
  `# launchd runs it as: runner.sh <slug> <command>, with ${DIR_VARIABLE} set.`,
  "set -u",
  "zmodload zsh/datetime",
  'slug="$1"',
  'command="$2"',
  `dir="$${DIR_VARIABLE}"`,
  'log="$dir/logs/$slug.log"',
  'runs="$dir/runs/$slug.jsonl"',
  'mkdir -p "${log:h}" "${runs:h}"',
  'if [[ -f "$log" && $(stat -f %z "$log") -gt 1048576 ]]; then',
  '  mv -f "$log" "$log.1"',
  "fi",
  "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "start_time=$EPOCHREALTIME",
  "{",
  '  print -r -- "=== $started start"',
  '  /bin/zsh -lc "$command"',
  "  code=$?",
  '  print -r -- "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) exit $code"',
  '} >> "$log" 2>&1',
  "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_ms=$(printf '%.0f' $(( (EPOCHREALTIME - start_time) * 1000 )))",
  'print -r -- "{\\"startedAt\\":\\"$started\\",\\"finishedAt\\":\\"$finished\\",\\"exitCode\\":$code,\\"durationMs\\":$duration_ms}" >> "$runs"',
  'if [[ $(stat -f %z "$runs") -gt 262144 ]]; then',
  '  tail -n 200 "$runs" > "$runs.tmp" && mv -f "$runs.tmp" "$runs"',
  "fi",
  "exit $code",
  "",
].join("\n");

/**
 * Writes a script launchd may start at any moment: to a temporary file beside
 * it, made executable, then renamed over it, so a fire sees the old script or
 * the new one and never an empty or half-written one.
 */
async function writeScript(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading plists

export interface PlistFile {
  Label?: unknown;
  ProgramArguments?: unknown;
  EnvironmentVariables?: unknown;
  StandardErrorPath?: unknown;
  WorkingDirectory?: unknown;
  StartCalendarInterval?: unknown;
  StartInterval?: unknown;
}

const PLIST_KEYS: Record<string, keyof CalendarEntry> = {
  Minute: "minute",
  Hour: "hour",
  Day: "day",
  Month: "month",
  Weekday: "weekday",
};

function calendarEntriesOf(value: unknown): CalendarEntry[] | null {
  if (value === undefined || value === null) return null;
  const dicts = Array.isArray(value) ? value : [value];
  const entries: CalendarEntry[] = [];
  for (const dict of dicts) {
    if (!isRecord(dict)) return null;
    const entry: CalendarEntry = {};
    for (const [key, field] of Object.entries(PLIST_KEYS)) {
      const raw = dict[key];
      if (raw === undefined) continue;
      if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
      entry[field] = raw;
    }
    entries.push(entry);
  }
  return entries;
}

export function scheduleOf(plist: PlistFile): Schedule {
  if (typeof plist.StartInterval === "number" && plist.StartInterval > 0) {
    const seconds = Math.round(plist.StartInterval);
    return { type: "interval", seconds, description: describeInterval(seconds) };
  }
  const entries = calendarEntriesOf(plist.StartCalendarInterval);
  if (entries === null) return { type: "none", description: "Only when run by hand" };
  const fields = fromCalendarEntries(entries);
  if (fields === null) return { type: "calendar", description: describeEntries(entries), entries };
  return { type: "cron", expression: formatCron(fields), description: describeCron(fields), entries };
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.:=+@%,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The data directory a plist names, when it names an absolute one. A plist
 * that names none — written by hand — gets `fallback`, where it will find
 * nothing, which is the truth: no runner writes its history.
 */
export function dataDirOf(plist: PlistFile | null, fallback: string): string {
  const env = plist?.EnvironmentVariables;
  const dir = isRecord(env) ? env[DIR_VARIABLE] : undefined;
  return typeof dir === "string" && dir.startsWith("/") ? dir.replace(/\/+$/, "") : fallback;
}

/**
 * The command as the user wrote it, when the plist is in the runner shape —
 * the runner of the data directory the plist itself names — or the spawn line
 * as launchd would run it otherwise, quoted for reading.
 */
export function commandOf(plist: PlistFile, dataDir: string): { command: string; managed: boolean } {
  const args = Array.isArray(plist.ProgramArguments)
    ? plist.ProgramArguments.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (args.length === 4 && args[0] === "/bin/zsh" && args[1] === join(dataDir, RUNNER_NAME)) {
    return { command: args[3] ?? "", managed: true };
  }
  return { command: args.map(shellQuote).join(" "), managed: false };
}

// ---------------------------------------------------------------------------
// launchd's view

interface LaunchdStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  runs: number | null;
  lastExitCode: number | null;
}

const UNLOADED: LaunchdStatus = { loaded: false, running: false, pid: null, runs: null, lastExitCode: null };

function matchInt(text: string, pattern: RegExp): number | null {
  const found = pattern.exec(text)?.[1];
  return found === undefined ? null : Number(found);
}

/**
 * `launchctl print` is the only place launchd reports state, and its output
 * is prose, so this reads the few lines whose shape has held across releases
 * and treats everything else as absent.
 */
export function statusOf(output: string): LaunchdStatus {
  const state = /^\s*state = (.+?)\s*$/m.exec(output)?.[1] ?? "";
  return {
    loaded: true,
    running: state.startsWith("running"),
    pid: matchInt(output, /^\s*pid = (\d+)\s*$/m),
    runs: matchInt(output, /^\s*runs = (\d+)\s*$/m),
    lastExitCode: matchInt(output, /^\s*last exit code = (-?\d+)\s*$/m),
  };
}

/** Labels `launchctl disable` has been applied to, from `print-disabled`. */
export function disabledLabelsOf(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const match of output.matchAll(/"([^"]+)" => disabled/g)) {
    const label = match[1];
    if (label !== undefined) disabled.add(label);
  }
  return disabled;
}

// ---------------------------------------------------------------------------
// Logs and history

function toRunRecord(line: string): RunRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.startedAt !== "string" ||
      typeof parsed.finishedAt !== "string" ||
      typeof parsed.exitCode !== "number" ||
      typeof parsed.durationMs !== "number"
    ) {
      return null;
    }
    return {
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
      exitCode: parsed.exitCode,
      durationMs: Math.max(0, Math.round(parsed.durationMs)),
    };
  } catch {
    return null;
  }
}

/**
 * A piece of a file, cut at line boundaries (`LogChunk`). A missing file is
 * empty, not an error: a job that has never run has no log yet.
 */
export async function readChunk(path: string, from: number | undefined, maxBytes: number): Promise<Omit<LogChunk, "path">> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return { text: "", pending: "", truncated: false, reset: from !== undefined && from > 0, next: 0 };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const extends_ = from !== undefined && from <= size && size - from <= maxBytes;
    const start = extends_ ? from : Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    // A tail that starts mid-file starts at its first whole line.
    let skip = 0;
    if (!extends_ && start > 0) {
      const newline = buffer.indexOf(10);
      skip = newline === -1 ? buffer.length : newline + 1;
    }
    const lastNewline = buffer.lastIndexOf(10);
    const end = lastNewline < skip ? skip : lastNewline + 1;
    return {
      text: buffer.subarray(skip, end).toString("utf8"),
      pending: buffer.subarray(end).toString("utf8"),
      truncated: !extends_ && start > 0,
      reset: !extends_ && from !== undefined,
      next: start + end,
    };
  } finally {
    await handle.close();
  }
}

/** The last `RECENT_RUNS` records of a history file, most recent first. */
export async function readRuns(path: string): Promise<RunRecord[]> {
  const { text } = await readChunk(path, undefined, RUNS_TAIL_BYTES);
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = toRunRecord(line);
    if (record !== null) records.push(record);
  }
  return records.slice(-RECENT_RUNS).reverse();
}

// ---------------------------------------------------------------------------
// Writing plists

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ENTRY_KEYS: ReadonlyArray<[keyof CalendarEntry, string]> = [
  ["minute", "Minute"],
  ["hour", "Hour"],
  ["day", "Day"],
  ["month", "Month"],
  ["weekday", "Weekday"],
];

function scheduleXml(schedule: JobSpec["schedule"]): string {
  if (schedule.type === "interval") {
    return `  <key>StartInterval</key>\n  <integer>${schedule.seconds}</integer>\n`;
  }
  const parsed = parseCron(schedule.expression);
  if (!parsed.ok) throw new Error(parsed.error);
  const dicts = toCalendarEntries(parsed.fields).map((entry) => {
    const keys = ENTRY_KEYS.filter(([field]) => entry[field] !== undefined)
      .map(([field, key]) => `      <key>${key}</key>\n      <integer>${entry[field]}</integer>\n`)
      .join("");
    return keys === "" ? "    <dict/>\n" : `    <dict>\n${keys}    </dict>\n`;
  });
  return `  <key>StartCalendarInterval</key>\n  <array>\n${dicts.join("")}  </array>\n`;
}

/**
 * The plist for a job whose files live in `dataDir`. There is no
 * `StandardOutPath`: the runner appends the command's output itself, which is
 * what lets it rotate the log. `StandardErrorPath` points at the same log only
 * so a failure in the runner *itself* lands somewhere.
 */
export function plistXml(input: { label: string; slug: string; spec: JobSpec; dataDir: string; path: string }): string {
  const { slug, spec, dataDir } = input;
  const env = [
    ["PATH", input.path],
    [DIR_VARIABLE, dataDir],
  ]
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value ?? "")}</string>\n`)
    .join("");
  const cwd = spec.cwd === null ? "" : `  <key>WorkingDirectory</key>\n  <string>${escapeXml(spec.cwd)}</string>\n`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>\n  <string>${escapeXml(input.label)}</string>`,
    "  <key>ProgramArguments</key>\n  <array>",
    "    <string>/bin/zsh</string>",
    `    <string>${escapeXml(join(dataDir, RUNNER_NAME))}</string>`,
    `    <string>${escapeXml(slug)}</string>`,
    `    <string>${escapeXml(spec.command)}</string>`,
    "  </array>",
    `${cwd}  <key>EnvironmentVariables</key>\n  <dict>\n${env}  </dict>`,
    scheduleXml(spec.schedule).trimEnd(),
    `  <key>StandardErrorPath</key>\n  <string>${escapeXml(join(dataDir, "logs", `${slug}.log`))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "job" : slug;
}

/** Validates what zod cannot: the cron parses, the directory is absolute. */
export function normaliseSpec(spec: JobSpec, home: string = homedir()): JobSpec {
  if (spec.schedule.type === "cron") {
    const parsed = parseCron(spec.schedule.expression);
    if (!parsed.ok) throw new Error(parsed.error);
  }
  let cwd = spec.cwd;
  if (cwd !== null) {
    if (cwd === "") cwd = null;
    else if (cwd === "~" || cwd.startsWith("~/")) cwd = join(home, cwd.slice(1));
    else if (!cwd.startsWith("/")) throw new Error("The working directory must be an absolute path");
  }
  return { ...spec, cwd };
}

// ---------------------------------------------------------------------------
// The jobs on one Mac

interface NameFile {
  names: Record<string, string>;
}

interface AckFile {
  acknowledged: Record<string, string>;
}

/** A string-to-string map from one key of a JSON file; anything else reads as empty. */
async function readStringMap(path: string, key: string, warn: (message: string) => void): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const entries = isRecord(parsed) ? parsed[key] : undefined;
    if (isRecord(entries)) {
      const clean: Record<string, string> = {};
      for (const [slug, value] of Object.entries(entries)) {
        if (typeof value === "string") clean[slug] = value;
      }
      return clean;
    }
  } catch (error) {
    if (!isMissing(error)) warn(`ignoring unreadable ${path}: ${errorMessage(error)}`);
  }
  return {};
}

export function createJobs(deps: JobsDeps) {
  const { ownDir, launchAgentsDir, run, warn } = deps;

  function domain(): string {
    if (deps.uid === undefined) throw new Error("Cannot determine the user id for the launchd gui domain");
    return `gui/${deps.uid}`;
  }

  function labelFor(slug: string): string {
    return `${LABEL_PREFIX}${slug}`;
  }

  function plistPath(slug: string): string {
    return join(launchAgentsDir, `${labelFor(slug)}.plist`);
  }

  function logPath(dir: string, slug: string): string {
    return join(dir, "logs", `${slug}.log`);
  }

  function runsPath(dir: string, slug: string): string {
    return join(dir, "runs", `${slug}.jsonl`);
  }

  const namesPath = join(ownDir, "jobs.json");
  const acksPath = join(ownDir, "acknowledged.json");

  async function launchctl(args: string[]): Promise<string> {
    try {
      return (await run("launchctl", args)).stdout;
    } catch (error) {
      throw new Error(`launchctl ${args.join(" ")} failed: ${failureText(error)}`);
    }
  }

  function assertSupported(): void {
    if (deps.platform !== "darwin") throw new Error("launchd jobs are only available on macOS");
  }

  // -- The plugin's own files ------------------------------------------------

  async function ensureRunner(): Promise<void> {
    await mkdir(join(ownDir, "logs"), { recursive: true });
    await mkdir(join(ownDir, "runs"), { recursive: true });
    const path = join(ownDir, RUNNER_NAME);
    let current: string | null = null;
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // Replaced, never rewritten in place: launchd may start it at any moment.
    if (current !== RUNNER_SCRIPT) await writeScript(path, RUNNER_SCRIPT);
  }

  async function writeOwn(path: string, key: string, map: Record<string, string>): Promise<void> {
    await mkdir(ownDir, { recursive: true });
    await writeFile(path, `${JSON.stringify({ [key]: map }, null, 2)}\n`, "utf8");
  }

  /**
   * Display names: this plugin's own map first, then the map in the job's own
   * data directory — which, for an adopted job, is the Paseo plugin's, read and
   * never written. A rename here lands in this plugin's map.
   */
  async function readNames(dirs: Iterable<string>): Promise<(slug: string, dir: string) => string> {
    const maps = new Map<string, Record<string, string>>();
    maps.set(ownDir, await readStringMap(namesPath, "names", warn));
    for (const dir of dirs) {
      if (!maps.has(dir)) maps.set(dir, await readStringMap(join(dir, "jobs.json"), "names", warn));
    }
    return (slug, dir) => maps.get(ownDir)?.[slug] ?? maps.get(dir)?.[slug] ?? slug;
  }

  /**
   * The failures the user has seen: this plugin's own file, then — for a slug
   * it has no word on — the one in the job's data directory, so a failure
   * already acknowledged in the Paseo plugin does not light the count up again.
   */
  async function readAcks(dirs: Iterable<string>): Promise<(slug: string, dir: string) => string | undefined> {
    const own = await readStringMap(acksPath, "acknowledged", warn);
    const others = new Map<string, Record<string, string>>();
    for (const dir of dirs) {
      if (dir !== ownDir && !others.has(dir)) {
        others.set(dir, await readStringMap(join(dir, "acknowledged.json"), "acknowledged", warn));
      }
    }
    return (slug, dir) => (slug in own ? own[slug] : others.get(dir)?.[slug]);
  }

  // -- Reading jobs ----------------------------------------------------------

  /** Parsed plists, keyed by path and kept while the file's mtime holds, so the health poll spawns no `plutil`. */
  const plistCache = new Map<string, { mtimeMs: number; plist: PlistFile }>();

  async function readPlist(path: string): Promise<PlistFile> {
    const { mtimeMs } = await stat(path);
    const cached = plistCache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.plist;
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path]);
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) throw new Error(`${path} is not a dictionary`);
    plistCache.set(path, { mtimeMs, plist: parsed });
    return parsed;
  }

  async function readPlistOrProblem(slug: string): Promise<{ plist: PlistFile | null; problem: string | null }> {
    try {
      return { plist: await readPlist(plistPath(slug)), problem: null };
    } catch (error) {
      return { plist: null, problem: `Could not read the plist: ${failureText(error)}` };
    }
  }

  /** `launchctl print` for one label, or null when it is not loaded. */
  async function printService(label: string): Promise<string | null> {
    try {
      return (await run("launchctl", ["print", `${domain()}/${label}`])).stdout;
    } catch (error) {
      const failure = error as CommandFailure;
      if (failure.code === 113 || /Could not find service/.test(failureText(error))) return null;
      throw new Error(`launchctl print ${label} failed: ${failureText(error)}`);
    }
  }

  async function readStatus(label: string): Promise<LaunchdStatus> {
    const output = await printService(label);
    return output === null ? UNLOADED : statusOf(output);
  }

  async function readDisabled(): Promise<Set<string>> {
    return disabledLabelsOf(await launchctl(["print-disabled", domain()]));
  }

  async function listSlugs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(launchAgentsDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names
      .filter((name) => name.startsWith(LABEL_PREFIX) && name.endsWith(".plist"))
      .map((name) => name.slice(LABEL_PREFIX.length, -".plist".length))
      .filter((slug) => slug !== "")
      .sort();
  }

  /**
   * Refuses an id that is not one of the plists under the prefix. That is the
   * ownership boundary, and it also keeps an id from naming a path anywhere
   * else.
   */
  async function assertKnown(slug: string): Promise<void> {
    if (!(await listSlugs()).includes(slug)) throw new Error(`No job "${slug}" under ${launchAgentsDir}`);
  }

  async function readJob(
    slug: string,
    read: { plist: PlistFile | null; problem: string | null },
    disabled: ReadonlySet<string>,
    nameOf: (slug: string, dir: string) => string,
  ): Promise<Job> {
    const label = labelFor(slug);
    const dir = dataDirOf(read.plist, ownDir);
    const [status, recentRuns] = await Promise.all([readStatus(label), readRuns(runsPath(dir, slug))]);
    const base = {
      id: slug,
      label,
      name: nameOf(slug, dir),
      plistPath: plistPath(slug),
      logPath: logPath(dir, slug),
      dataDir: dir,
      adopted: dir !== ownDir,
      disabled: disabled.has(label),
      ...status,
      recentRuns,
    };
    if (read.plist === null) {
      return {
        ...base,
        command: "",
        cwd: null,
        schedule: { type: "none", description: "Unknown" },
        managed: false,
        problem: read.problem,
      };
    }
    const { command, managed } = commandOf(read.plist, dir);
    return {
      ...base,
      command,
      cwd: typeof read.plist.WorkingDirectory === "string" ? read.plist.WorkingDirectory : null,
      schedule: scheduleOf(read.plist),
      managed,
      problem: null,
    };
  }

  async function loadJob(slug: string): Promise<Job> {
    const read = await readPlistOrProblem(slug);
    const [disabled, nameOf] = await Promise.all([readDisabled(), readNames([dataDirOf(read.plist, ownDir)])]);
    return readJob(slug, read, disabled, nameOf);
  }

  /** Where a job's files are, from its plist; this plugin's own directory when it names none. */
  async function dataDirFor(slug: string): Promise<string> {
    return dataDirOf((await readPlistOrProblem(slug)).plist, ownDir);
  }

  // -- Writing jobs ----------------------------------------------------------

  /** The PATH a job gets; see AGENTS.md, "The runner". */
  async function loginShellPath(): Promise<string> {
    for (const flags of ["-lic", "-lc"]) {
      try {
        const { stdout } = await run("/bin/zsh", [flags, 'print -r -- "$PATH"'], {
          timeoutMs: 5000,
          env: { ...process.env, TERM: "dumb" },
        });
        // A startup file may print its own lines first; the PATH is the last
        // line that looks like one.
        const line = stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry.includes("/"))
          .pop();
        if (line !== undefined && line !== "") return line;
      } catch (error) {
        warn(`zsh ${flags} PATH probe failed: ${failureText(error)}`);
      }
    }
    return deps.envPath ?? FALLBACK_PATH;
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * Where a saved job's files go. A job keeps the data directory its plist
   * already names — an adopted job keeps writing its history beside the Paseo
   * plugin's, so nothing it ran before drops out of view — as long as that
   * directory still has a runner. Everything else is this plugin's own.
   */
  async function directoryForSave(current: string | null): Promise<string> {
    if (current !== null && current !== ownDir && (await exists(join(current, RUNNER_NAME)))) return current;
    await ensureRunner();
    return ownDir;
  }

  async function writeJob(slug: string, spec: JobSpec, dataDir: string): Promise<void> {
    const path = await loginShellPath();
    const names = await readStringMap(namesPath, "names", warn);
    names[slug] = spec.name;
    await writeOwn(namesPath, "names", names);
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(plistPath(slug), plistXml({ label: labelFor(slug), slug, spec, dataDir, path }), "utf8");
  }

  /** Ignores "not loaded"; anything else is a real failure. */
  async function bootoutIfLoaded(label: string): Promise<void> {
    try {
      await run("launchctl", ["bootout", `${domain()}/${label}`]);
    } catch (error) {
      const text = failureText(error);
      if (/No such process|Could not find service/.test(text)) return;
      throw new Error(`launchctl bootout ${label} failed: ${text}`);
    }
  }

  async function bootstrap(slug: string): Promise<void> {
    await launchctl(["bootstrap", domain(), plistPath(slug)]);
  }

  async function uniqueSlug(name: string): Promise<string> {
    const taken = new Set(await listSlugs());
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // -- Handlers --------------------------------------------------------------

  return {
    labelFor,
    logPath,
    dataDirFor,
    assertKnown,

    async list(): Promise<JobList> {
      if (deps.platform !== "darwin") return { supported: false, jobs: [], launchAgentsDir };
      const slugs = await listSlugs();
      const reads = await Promise.all(slugs.map((slug) => readPlistOrProblem(slug)));
      const dirs = reads.map((read) => dataDirOf(read.plist, ownDir));
      const [disabled, nameOf] = await Promise.all([readDisabled(), readNames(dirs)]);
      const jobs = await Promise.all(slugs.map((slug, index) => readJob(slug, reads[index]!, disabled, nameOf)));
      return { supported: true, jobs, launchAgentsDir };
    },

    async create(input: JobSpec): Promise<Job> {
      assertSupported();
      const spec = normaliseSpec(input);
      const slug = await uniqueSlug(spec.name);
      await writeJob(slug, spec, await directoryForSave(null));
      // The file stays if launchd refuses it: the list shows it unloaded with
      // the error in hand, and Enable retries once the cause is fixed.
      await bootstrap(slug);
      return loadJob(slug);
    },

    async update(input: { id: string; spec: JobSpec }): Promise<Job> {
      assertSupported();
      await assertKnown(input.id);
      const spec = normaliseSpec(input.spec);
      const label = labelFor(input.id);
      const [disabled, current] = await Promise.all([readDisabled(), readPlistOrProblem(input.id)]);
      const dataDir = await directoryForSave(current.plist === null ? null : dataDirOf(current.plist, ownDir));
      // launchd does not reread a changed plist; the job has to leave and return.
      await bootoutIfLoaded(label);
      await writeJob(input.id, spec, dataDir);
      if (!disabled.has(label)) await bootstrap(input.id);
      return loadJob(input.id);
    },

    async delete(input: { id: string }): Promise<Record<string, never>> {
      assertSupported();
      await assertKnown(input.id);
      const label = labelFor(input.id);
      const dir = await dataDirFor(input.id);
      await bootoutIfLoaded(label);
      // A `disable` outlives the plist: launchd keeps it per label in its own
      // override store, so without this a later job with the same slug would be
      // born disabled.
      try {
        await launchctl(["enable", `${domain()}/${label}`]);
      } catch (error) {
        warn(`could not clear the disabled flag for ${label}: ${errorMessage(error)}`);
      }
      const log = logPath(dir, input.id);
      for (const path of [plistPath(input.id), log, `${log}.1`, runsPath(dir, input.id)]) {
        try {
          await unlink(path);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      plistCache.delete(plistPath(input.id));
      const names = await readStringMap(namesPath, "names", warn);
      if (input.id in names) {
        delete names[input.id];
        await writeOwn(namesPath, "names", names);
      }
      const acks = await readStringMap(acksPath, "acknowledged", warn);
      if (input.id in acks) {
        delete acks[input.id];
        await writeOwn(acksPath, "acknowledged", acks);
      }
      return {};
    },

    async run(input: { id: string }): Promise<Record<string, never>> {
      assertSupported();
      await assertKnown(input.id);
      const label = labelFor(input.id);
      const status = await readStatus(label);
      if (!status.loaded) throw new Error("The job is not loaded; enable it first");
      await launchctl(["kickstart", `${domain()}/${label}`]);
      return {};
    },

    async setEnabled(input: { id: string; enabled: boolean }): Promise<Job> {
      assertSupported();
      await assertKnown(input.id);
      const label = labelFor(input.id);
      if (input.enabled) {
        // `enable` first: bootstrapping a disabled label is refused.
        await launchctl(["enable", `${domain()}/${label}`]);
        await bootoutIfLoaded(label);
        await bootstrap(input.id);
      } else {
        await bootoutIfLoaded(label);
        await launchctl(["disable", `${domain()}/${label}`]);
      }
      return loadJob(input.id);
    },

    async log(input: { id: string; from?: number }): Promise<LogChunk> {
      assertSupported();
      await assertKnown(input.id);
      const path = logPath(await dataDirFor(input.id), input.id);
      return { ...(await readChunk(path, input.from, LOG_TAIL_BYTES)), path };
    },

    /**
     * Which jobs are failing and unacknowledged. Deliberately free of
     * `launchctl`: the server polls this whether or not the panel is open, and
     * everything it needs is the plists (parsed once per change) and the last
     * line of each history file. A job launchd has quietly stopped scheduling
     * therefore does not show up here — the panel's status column is where
     * that is visible.
     */
    async health(): Promise<{ supported: boolean; jobCount: number; failing: FailingJob[] }> {
      if (deps.platform !== "darwin") return { supported: false, jobCount: 0, failing: [] };
      const slugs = await listSlugs();
      const dirs = await Promise.all(slugs.map((slug) => dataDirFor(slug)));
      const [nameOf, ackOf] = await Promise.all([readNames(dirs), readAcks(dirs)]);
      const checked = await Promise.all(
        slugs.map(async (slug, index): Promise<FailingJob | null> => {
          const dir = dirs[index]!;
          const last = (await readRuns(runsPath(dir, slug)))[0];
          if (last === undefined || last.exitCode === 0) return null;
          if (ackOf(slug, dir) === last.startedAt) return null;
          return { id: slug, name: nameOf(slug, dir) };
        }),
      );
      return { supported: true, jobCount: slugs.length, failing: checked.filter((entry) => entry !== null) };
    },

    /**
     * Remembers that the user has seen this job's latest run, in this plugin's
     * own file. A job whose latest run succeeded loses its entry instead of
     * gaining one, so acknowledging is never what makes a later failure
     * silent. Entries for jobs that no longer exist are dropped on the way past.
     */
    async acknowledge(input: { id: string }): Promise<Record<string, never>> {
      assertSupported();
      const slugs = await listSlugs();
      if (!slugs.includes(input.id)) throw new Error(`No job "${input.id}" under ${launchAgentsDir}`);
      const dir = await dataDirFor(input.id);
      const [last, acks] = await Promise.all([
        readRuns(runsPath(dir, input.id)).then((runs) => runs[0]),
        readStringMap(acksPath, "acknowledged", warn),
      ]);
      const known = new Set(slugs);
      const next: Record<string, string> = {};
      for (const [slug, startedAt] of Object.entries(acks)) {
        if (known.has(slug)) next[slug] = startedAt;
      }
      if (last === undefined || last.exitCode === 0) delete next[input.id];
      else next[input.id] = last.startedAt;
      await writeOwn(acksPath, "acknowledged", next);
      return {};
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
