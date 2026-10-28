/**
 * Reverting an uncommitted change in the checkout, on the machine that holds it: a whole file back to
 * `HEAD` (a new file removed, a deleted one put back), or some of its hunks.
 *
 * It acts only on the version the user reviewed. The tab sends the file's revision as bb's Git plugin
 * listed it, `oldMode:oldBlob:newMode:newBlob`. This reads the working file's bytes once, hashes those
 * bytes as bb does (`git hash-object --path`, so the file's attributes and line-ending rules apply),
 * whatever blob git's diff reported, and refuses unless the revision is the tab's. Every later step is
 * bound to that byte snapshot: just before the file is replaced (an exclusive temporary file, then a
 * rename) or removed, a synchronous check, with no await in between, compares the file's bytes with it,
 * so a save another process makes in that same instant is the only change it can miss.
 *
 * Nothing is written outside the checkout: every folder on the way to the file must be a real folder
 * inside it (a symlinked one is refused), checked again in that last synchronous step. Symlinks and
 * submodules are refused too.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { revertHunks } from "../shared/revert";
import type { RunGit } from "./git";

export class RevertRefused extends Error {}

export interface RevertRequest {
  root: string;
  path: string;
  /** The revision the tab showed. */
  revision: string;
  /** Hunk indexes of `patch` to revert, or null for the whole file. */
  hunks: number[] | null;
  /** The file's patch at that revision, for a hunk revert. */
  patch: string | null;
}

export interface RevertOptions {
  /** The temporary file's name beside `target`; random unless a test says otherwise. */
  temporaryName?: (target: string) => string;
}

interface Entry {
  oldMode: string;
  oldBlob: string;
  newMode: string;
}

/** The bytes of the working copy, read once, and what they are. */
interface Snapshot {
  bytes: Buffer;
  mode: string;
}

const CHANGED = (path: string) => new RevertRefused(`${path} changed since the diff was loaded; reload and try again.`);

function inside(root: string, path: string): string {
  const absolute = join(root, path);
  const rel = relative(root, absolute);
  if (path === "" || isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new RevertRefused(`${path} is not a file of this workspace.`);
  return absolute;
}

/**
 * Throws unless every folder from the checkout to the file is a real folder inside the checkout (no
 * symlinked folder, nothing that leads out). With `create`, missing folders are made, one by one.
 * Synchronous, so it can run in the last step before a change.
 */
function checkFolders(root: string, path: string, create: boolean): void {
  const rootReal = realpathSync(root);
  const parts = relative(root, dirname(join(root, path))).split(sep).filter((part) => part !== "");
  let folder = root;
  for (const part of parts) {
    folder = join(folder, part);
    let info;
    try {
      info = lstatSync(folder);
    } catch {
      if (!create) throw CHANGED(path);
      mkdirSync(folder, { mode: 0o755 });
      info = lstatSync(folder);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RevertRefused(`${path} is inside a symlinked folder or one that is not a folder, which is not reverted here; use git.`);
  }
  const parentReal = realpathSync(folder);
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) throw new RevertRefused(`${path} is not a file of this workspace.`);
}

/** The working copy's bytes and mode, or null when it is gone; a symlink's bytes are its target. */
function working(absolute: string): Snapshot | null {
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) return { bytes: Buffer.from(readlinkSync(absolute)), mode: "120000" };
  if (!info.isFile()) return { bytes: Buffer.alloc(0), mode: "040000" };
  return { bytes: readFileSync(absolute), mode: (info.mode & 0o111) === 0 ? "100644" : "100755" };
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex");
}

async function entryOf(run: RunGit, root: string, path: string, absolute: string): Promise<Entry> {
  const raw = await run(root, ["diff", "--no-ext-diff", "--raw", "--no-abbrev", "-z", "HEAD", "--", path], { allowFailure: true });
  if (!raw.ok) throw new RevertRefused("This workspace has no commit to revert to.");
  const head = raw.stdout.split("\0")[0] ?? "";
  const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(head);
  if (match !== null) return { oldMode: match[1]!, newMode: match[2]!, oldBlob: match[3]! };
  const untracked = await run(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  if (!untracked.stdout.split("\0").includes(path)) throw new RevertRefused(`${path} has no uncommitted change now.`);
  const file = working(absolute);
  if (file === null) throw new RevertRefused(`${path} has no uncommitted change now.`);
  return { oldMode: "000000", oldBlob: "0".repeat(40), newMode: file.mode };
}

/** The blob git makes of `bytes` at `path`, its attributes applied, as bb's `git hash-object -- <path>`. */
async function hashAt(run: RunGit, root: string, path: string, bytes: Buffer): Promise<string> {
  return (await run(root, ["hash-object", "--stdin", `--path=${path}`], { input: bytes })).stdout.trim();
}

/** The revision of a snapshot, as bb's Git plugin lists it for the uncommitted view. */
async function revisionOf(run: RunGit, root: string, path: string, entry: Entry, snapshot: Snapshot | null): Promise<string> {
  const newBlob = entry.newMode === "000000" || snapshot === null ? "0".repeat(entry.oldBlob.length) : await hashAt(run, root, path, snapshot.bytes);
  return `${entry.oldMode}:${entry.oldBlob}:${entry.newMode}:${newBlob}`;
}

/** Throws unless the working copy still is `snapshot`'s bytes (synchronous: no await). */
function stillReviewed(absolute: string, path: string, snapshot: Snapshot): void {
  const now = working(absolute);
  if (now === null || now.mode === "120000" || now.mode === "040000" || !sameBytes(now.bytes, snapshot.bytes)) throw CHANGED(path);
}

function fileMode(mode: string): number {
  return mode === "100755" ? 0o755 : 0o644;
}

/**
 * Replaces the file with `bytes` if it still is the reviewed snapshot: the new bytes go into a
 * temporary file of a random name created exclusively (never through a link or over a file that is
 * there), written and given its mode through its own descriptor, then renamed over the file.
 */
function replace(root: string, path: string, absolute: string, snapshot: Snapshot, bytes: Buffer, mode: string, options: RevertOptions): void {
  const temporary = options.temporaryName?.(absolute) ?? join(dirname(absolute), `.diff-review-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(temporary, "wx", fileMode(mode));
  } catch {
    throw new RevertRefused(`Could not create a temporary file beside ${path}; nothing was changed.`);
  }
  try {
    try {
      writeSync(fd, bytes);
      fchmodSync(fd, fileMode(mode));
    } finally {
      closeSync(fd);
    }
    checkFolders(root, path, false);
    stillReviewed(absolute, path, snapshot);
    renameSync(temporary, absolute);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
    throw error;
  }
}


/** The file's revision now, as bb's Git plugin lists it for the uncommitted view. */
export async function currentRevision(run: RunGit, root: string, path: string): Promise<string> {
  const absolute = inside(root, path);
  const entry = await entryOf(run, root, path, absolute);
  return revisionOf(run, root, path, entry, entry.newMode === "000000" ? null : working(absolute));
}

export async function revert(run: RunGit, request: RevertRequest, options: RevertOptions = {}): Promise<void> {
  const { root, path } = request;
  const absolute = inside(root, path);
  checkFolders(root, path, false);
  const entry = await entryOf(run, root, path, absolute);
  if ([entry.oldMode, entry.newMode].some((mode) => mode === "120000" || mode === "160000")) {
    throw new RevertRefused(`${path} is a symlink or a submodule, which is not reverted here; use git.`);
  }
  // The bytes reviewed: read once, hashed as bb hashes them, and every later check is against them.
  const snapshot = entry.newMode === "000000" ? null : working(absolute);
  if (entry.newMode !== "000000" && (snapshot === null || snapshot.mode === "120000" || snapshot.mode === "040000")) throw CHANGED(path);
  if ((await revisionOf(run, root, path, entry, snapshot)) !== request.revision) throw CHANGED(path);

  if (request.hunks !== null) {
    if (snapshot === null || request.patch === null) throw new RevertRefused(`${path} has no hunks to revert; revert the whole file.`);
    const text = snapshot.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(snapshot.bytes)) throw new RevertRefused(`${path} is not UTF-8 text, so its hunks are not reverted here.`);
    const next = revertHunks(text, request.patch, request.hunks);
    if (next === null) throw CHANGED(path);
    replace(root, path, absolute, snapshot, Buffer.from(next, "utf8"), snapshot.mode, options);
    return;
  }
  if (entry.oldMode === "000000") {
    // A new file: removed, if it still is the reviewed one.
    checkFolders(root, path, false);
    stillReviewed(absolute, path, snapshot!);
    unlinkSync(absolute);
    return;
  }
  const committed = Buffer.from((await run(root, ["cat-file", "blob", entry.oldBlob], { maxBuffer: 256 * 1024 * 1024, bytes: true })).stdout, "latin1");
  if (entry.newMode === "000000") {
    // A deleted file: put back, through real folders only, where nothing has been created since.
    checkFolders(root, path, true);
    let fd;
    try {
      fd = openSync(absolute, "wx", fileMode(entry.oldMode));
    } catch {
      throw CHANGED(path);
    }
    try {
      writeSync(fd, committed);
    } finally {
      closeSync(fd);
    }
    return;
  }
  replace(root, path, absolute, snapshot!, committed, entry.oldMode, options);
}
