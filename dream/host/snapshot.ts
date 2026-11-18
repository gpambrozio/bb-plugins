/**
 * What a memory folder holds, as a manifest of its `.md` files, and the backups taken before every
 * change: `<backups>/<stamp>.tar.gz`, made with the system `tar` (bsdtar on macOS, GNU tar on Linux,
 * both read `-czf`, `-xzf` and `--exclude`).
 *
 * A dream changes only `.md` files outside `.git/` and `agents/` (at any depth, without case), and
 * the walk follows no symlink, so a manifest lists regular files reached through real folders only.
 * That is what a manifest lists and
 * what a restore puts back: it removes the `.md` files the backup does not have and writes the ones
 * it does. Anything else in the folder (a `.git/`, notes in other formats) is never touched. Every
 * restore takes a backup of what it replaces first, so it can be undone the same way.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** As the guard: `.git` and `agents` at any depth, without case (macOS volumes ignore it). */
export function isProtectedName(name: string): boolean {
  return [".git", "agents"].includes(name.normalize("NFC").toLowerCase());
}
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
        if (!isProtectedName(entry.name)) walk(path.join(folder, entry.name), relative);
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

/**
 * When someone last wrote memory: the newest mtime of the folder's `.md` files, or null when it has
 * none. The folder's own mtime is left out on purpose: taking and rolling back the lock creates and
 * removes a file in it, so the plugin's own lock would otherwise read as a change to the memory, move a
 * lock-less project's baseline, and make it look busy for the quiet period.
 */
export function newestChange(dir: string): number | null {
  let newest: number | null = null;
  for (const file of markdownFiles(dir)) {
    try {
      newest = Math.max(newest ?? 0, statSync(path.join(dir, ...file.split("/"))).mtimeMs);
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

export class UnsafePathError extends Error {}

/**
 * The absolute path of `relative` inside the memory folder, after checking that writing or deleting
 * it cannot leave the folder: no `..`, no protected folder, every existing folder on the way a real
 * directory (not a symlink), and the file itself, if it exists, a regular file. Throws
 * `UnsafePathError` otherwise. Apply and restore never pass through the dream's guard, so they check
 * here, right before each change.
 */
export function containedPath(root: string, relative: string): string {
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new UnsafePathError(`${relative} is not a plain relative path`);
  if (parts.slice(0, -1).some(isProtectedName)) throw new UnsafePathError(`${relative} is in a protected folder`);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch {
    throw new UnsafePathError(`the memory folder ${root} does not exist`);
  }
  if (!rootStats.isDirectory()) throw new UnsafePathError(`the memory folder ${root} is not a directory`);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.join(root, ...parts);
      throw new UnsafePathError(`${current} cannot be inspected`);
    }
    const last = index === parts.length - 1;
    if (stats.isSymbolicLink()) throw new UnsafePathError(`${current} is a symlink`);
    if (!last && !stats.isDirectory()) throw new UnsafePathError(`${current} is not a directory`);
    if (last && !stats.isFile()) throw new UnsafePathError(`${current} is not a regular file`);
  }
  return path.join(root, ...parts);
}

/** Copies `source` to `relative` in the memory folder through a temporary file beside it, contained. */
export function writeMemoryFile(root: string, relative: string, source: string): void {
  const target = containedPath(root, relative);
  // Make the missing folders one at a time, re-checking, so none of them can be a link.
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  containedPath(root, relative);
  const temporary = `${target}.dream-${process.pid}-${Date.now()}`;
  copyFileSync(source, temporary, constants.COPYFILE_EXCL);
  renameSync(temporary, target);
}

export function removeMemoryFile(root: string, relative: string): void {
  rmSync(containedPath(root, relative), { force: true });
}

/**
 * Makes the memory folder's `.md` files those of `fromDir`, leaving every other file alone. Every
 * target is checked before anything changes, and again as it changes. Answers what changed.
 */
export function syncMarkdown(fromDir: string, memoryDir: string): Changes {
  const changes = diffManifests(manifest(memoryDir), manifest(fromDir));
  for (const file of [...changes.added, ...changes.changed, ...changes.deleted]) containedPath(memoryDir, file);
  for (const file of [...changes.added, ...changes.changed]) writeMemoryFile(memoryDir, file, path.join(fromDir, ...file.split("/")));
  for (const file of changes.deleted) removeMemoryFile(memoryDir, file);
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
