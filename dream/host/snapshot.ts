/**
 * What a memory folder holds, as a manifest of its `.md` files, and the backups taken before every
 * change: `<backups>/<stamp>.tar.gz`, made with the system `tar` (bsdtar on macOS, GNU tar on Linux,
 * both read `-czf`, `-xzf` and `--exclude`).
 *
 * A dream changes only `.md` files outside `.git/` and `agents/`, so that is what a manifest lists and
 * what a restore puts back: it removes the `.md` files the backup does not have and writes the ones
 * it does. Anything else in the folder (a `.git/`, notes in other formats) is never touched. Every
 * restore takes a backup of what it replaces first, so it can be undone the same way.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROTECTED = new Set([".git", "agents"]);
const TAR_TIMEOUT_MS = 120_000;

/** `relative path` → sha256 of each `.md` file a dream may change. */
export type Manifest = Record<string, string>;

export interface Changes {
  added: string[];
  changed: string[];
  deleted: string[];
}

export function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (folder: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!(prefix === "" && PROTECTED.has(entry.name)) && entry.name !== ".git") walk(path.join(folder, entry.name), relative);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(relative);
      }
    }
  };
  walk(dir, "");
  return files.sort();
}

export function manifest(dir: string): Manifest {
  const result: Manifest = {};
  for (const file of markdownFiles(dir)) {
    result[file] = createHash("sha256").update(readFileSync(path.join(dir, ...file.split("/")))).digest("hex");
  }
  return result;
}

export function diffManifests(before: Manifest, after: Manifest): Changes {
  const added = Object.keys(after).filter((file) => !(file in before));
  const deleted = Object.keys(before).filter((file) => !(file in after));
  const changed = Object.keys(after).filter((file) => file in before && before[file] !== after[file]);
  return { added: added.sort(), changed: changed.sort(), deleted: deleted.sort() };
}

export function changeCount(changes: Changes): number {
  return changes.added.length + changes.changed.length + changes.deleted.length;
}

/** The newest mtime of the folder itself and its `.md` files: when someone last wrote memory. */
export function newestChange(dir: string): number | null {
  let newest: number | null = null;
  try {
    newest = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  for (const file of markdownFiles(dir)) {
    try {
      newest = Math.max(newest, statSync(path.join(dir, ...file.split("/"))).mtimeMs);
    } catch {
      // Removed while reading.
    }
  }
  return newest;
}

/** A time as a backup or proposal name: `20261117T010500123Z`, which sorts by time. */
export function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

export function stampTime(stamp: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TAR_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

/** Archives the memory folder, `.git/` and the lock left out, into `<backupsDir>/<stamp>.tar.gz`. */
export async function backup(memoryDir: string, backupsDir: string, stamp: string): Promise<string> {
  mkdirSync(backupsDir, { recursive: true });
  const target = path.join(backupsDir, `${stamp}.tar.gz`);
  const partial = `${target}.partial`;
  await run("tar", ["-czf", partial, "--exclude=.git", "--exclude=.consolidate-lock", "-C", memoryDir, "."]);
  renameSync(partial, target);
  return target;
}

export interface BackupEntry {
  stamp: string;
  file: string;
  size: number;
}

export function listBackups(backupsDir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".tar.gz") && stampTime(name.slice(0, -".tar.gz".length)) !== null)
    .map((name) => {
      const file = path.join(backupsDir, name);
      return { stamp: name.slice(0, -".tar.gz".length), file, size: statSync(file).size };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** Keeps the `keep` newest backups and deletes the rest; answers what it deleted. */
export function pruneBackups(backupsDir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const entry of listBackups(backupsDir).slice(Math.max(1, keep))) {
    unlinkSync(entry.file);
    removed.push(entry.stamp);
  }
  return removed;
}

/** Writes `source` over `target` through a temporary file in the same folder. */
function replaceFile(source: string, target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.dream-${process.pid}-${Date.now()}`;
  copyFileSync(source, temporary);
  renameSync(temporary, target);
}

/**
 * Makes the memory folder's `.md` files those of `fromDir`, leaving every other file alone.
 * Answers what changed.
 */
export function syncMarkdown(fromDir: string, memoryDir: string): Changes {
  const changes = diffManifests(manifest(memoryDir), manifest(fromDir));
  for (const file of [...changes.added, ...changes.changed]) replaceFile(path.join(fromDir, ...file.split("/")), path.join(memoryDir, ...file.split("/")));
  for (const file of changes.deleted) rmSync(path.join(memoryDir, ...file.split("/")), { force: true });
  return changes;
}

/** Puts the backup's `.md` files back. The caller takes a backup of the current state first. */
export async function restoreBackup(archive: string, memoryDir: string): Promise<Changes> {
  const scratch = mkdtempSync(path.join(tmpdir(), "dream-restore-"));
  try {
    await run("tar", ["-xzf", archive, "-C", scratch]);
    mkdirSync(memoryDir, { recursive: true });
    return syncMarkdown(scratch, memoryDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
