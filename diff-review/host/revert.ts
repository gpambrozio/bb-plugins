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
import { closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
  /** Writes to a descriptor, as `fs.writeSync`; a test passes one that writes less than asked. */
  write?: (fd: number, bytes: Buffer, offset: number, length: number) => number;
}

/**
 * Writes all of `bytes` to `fd`: a write may take fewer bytes than asked (a full disk, a file-size
 * limit), so it goes on from where the last one stopped, and refuses on an error or a write that
 * takes nothing.
 */
export function writeAll(fd: number, bytes: Buffer, path: string, write: NonNullable<RevertOptions["write"]> = writeSync): void {
  let offset = 0;
  while (offset < bytes.length) {
    let written: number;
    try {
      written = write(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      throw new RevertRefused(`Could not write ${path} (${error instanceof Error ? error.message : String(error)}); nothing was changed.`);
    }
    if (!(written > 0)) throw new RevertRefused(`Could not write ${path}: the disk took no more bytes; nothing was changed.`);
    offset += written;
  }
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
 * The checkout as Revert works on it: its real path, taken once before anything is awaited, and the
 * folder's identity. Every path is built from that real path, and every check confirms it still is
 * the same folder, so neither the checkout nor any folder above it can be swapped for a link mid-way.
 */
interface Checkout {
  real: string;
  dev: number;
  ino: number;
}

function checkoutOf(root: string): Checkout {
  let real;
  try {
    real = realpathSync(root);
  } catch {
    throw new RevertRefused("The workspace's folder is gone.");
  }
  const info = lstatSync(real);
  if (!info.isDirectory()) throw new RevertRefused("The workspace's folder is not a folder.");
  return { real, dev: info.dev, ino: info.ino };
}

const MOVED = () => new RevertRefused("The workspace's folder moved or was replaced while reverting; nothing was changed.");

/**
 * Throws unless the checkout still is the folder it was and every folder from it to the file is a
 * real folder inside it (no symlinked folder, nothing that leads out). A missing folder is refused,
 * allowed (the walk stops there: the check before a restore makes it), or made, one by one.
 * Synchronous, so it runs in the same step as the change it guards.
 */
function checkFolders(checkout: Checkout, path: string, missing: "refuse" | "allow" | "create"): void {
  let top;
  try {
    top = lstatSync(checkout.real);
  } catch {
    throw MOVED();
  }
  if (top.isSymbolicLink() || !top.isDirectory() || top.dev !== checkout.dev || top.ino !== checkout.ino) throw MOVED();
  const parts = relative(checkout.real, dirname(join(checkout.real, path))).split(sep).filter((part) => part !== "");
  let folder = checkout.real;
  for (const part of parts) {
    folder = join(folder, part);
    let info;
    try {
      info = lstatSync(folder);
    } catch {
      if (missing === "refuse") throw CHANGED(path);
      if (missing === "allow") return;
      mkdirSync(folder, { mode: 0o755 });
      info = lstatSync(folder);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RevertRefused(`${path} is inside a symlinked folder or one that is not a folder, which is not reverted here; use git.`);
  }
  const parentReal = realpathSync(folder);
  if (parentReal !== checkout.real && !parentReal.startsWith(`${checkout.real}${sep}`)) throw new RevertRefused(`${path} is not a file of this workspace.`);
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
 * Removes a temporary file this made, only while the checkout and its folders still are what they
 * were: through a folder swapped since, the name could lead somewhere else, and then it is left.
 */
function dropTemporary(checkout: Checkout, path: string, temporary: string): void {
  try {
    checkFolders(checkout, path, "refuse");
    unlinkSync(temporary);
  } catch {
    // Gone already, or no longer safely reachable: left alone.
  }
}

/**
 * Writes `bytes` into a temporary file of a random name beside the file, created exclusively (never
 * through a link or over a file that is there), written in full and given its mode through its own
 * descriptor, in the same synchronous step as the folder check before it. On any failure only that
 * temporary file is removed.
 */
function stage(checkout: Checkout, path: string, absolute: string, bytes: Buffer, mode: string, options: RevertOptions): string {
  checkFolders(checkout, path, "refuse");
  const temporary = options.temporaryName?.(absolute) ?? join(dirname(absolute), `.diff-review-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(temporary, "wx", fileMode(mode));
  } catch {
    throw new RevertRefused(`Could not create a temporary file beside ${path}; nothing was changed.`);
  }
  try {
    try {
      writeAll(fd, bytes, path, options.write);
      fchmodSync(fd, fileMode(mode));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    dropTemporary(checkout, path, temporary);
    throw error;
  }
  return temporary;
}

/** Replaces the file with `bytes` if it still is the reviewed snapshot: staged, then renamed over it. */
function replace(checkout: Checkout, path: string, absolute: string, snapshot: Snapshot, bytes: Buffer, mode: string, options: RevertOptions): void {
  stillReviewed(absolute, path, snapshot);
  const temporary = stage(checkout, path, absolute, bytes, mode, options);
  try {
    checkFolders(checkout, path, "refuse");
    stillReviewed(absolute, path, snapshot);
    renameSync(temporary, absolute);
  } catch (error) {
    dropTemporary(checkout, path, temporary);
    throw error;
  }
}

/**
 * Puts a deleted file back with `bytes`: staged in full, then hard-linked to its name, which fails
 * when anything has been created there since, so nothing is ever overwritten and a failure only ever
 * removes the temporary file. A file system without hard links is refused, not written another way.
 */
function restore(checkout: Checkout, path: string, absolute: string, bytes: Buffer, mode: string, options: RevertOptions): void {
  checkFolders(checkout, path, "create");
  const temporary = stage(checkout, path, absolute, bytes, mode, options);
  try {
    checkFolders(checkout, path, "refuse");
    try {
      linkSync(temporary, absolute);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") throw CHANGED(path);
      throw new RevertRefused(`Could not put ${path} back (${error instanceof Error ? error.message : String(error)}); nothing was changed.`);
    }
  } catch (error) {
    dropTemporary(checkout, path, temporary);
    throw error;
  }
  dropTemporary(checkout, path, temporary);
}

/** The file's revision now, as bb's Git plugin lists it for the uncommitted view. */
export async function currentRevision(run: RunGit, root: string, path: string): Promise<string> {
  const absolute = inside(root, path);
  const entry = await entryOf(run, root, path, absolute);
  return revisionOf(run, root, path, entry, entry.newMode === "000000" ? null : working(absolute));
}

export async function revert(run: RunGit, request: RevertRequest, options: RevertOptions = {}): Promise<void> {
  const { root, path } = request;
  // The checkout's real path and identity, before anything is awaited; every path below is built on it.
  const checkout = checkoutOf(root);
  const absolute = inside(checkout.real, path);
  // A deleted file's folders may be gone too; they are made when it is put back.
  checkFolders(checkout, path, "allow");
  const entry = await entryOf(run, checkout.real, path, absolute);
  if ([entry.oldMode, entry.newMode].some((mode) => mode === "120000" || mode === "160000")) {
    throw new RevertRefused(`${path} is a symlink or a submodule, which is not reverted here; use git.`);
  }
  // The bytes reviewed: read once, hashed as bb hashes them, and every later check is against them.
  const snapshot = entry.newMode === "000000" ? null : working(absolute);
  if (entry.newMode !== "000000" && (snapshot === null || snapshot.mode === "120000" || snapshot.mode === "040000")) throw CHANGED(path);
  if ((await revisionOf(run, checkout.real, path, entry, snapshot)) !== request.revision) throw CHANGED(path);

  if (request.hunks !== null) {
    if (snapshot === null || request.patch === null) throw new RevertRefused(`${path} has no hunks to revert; revert the whole file.`);
    const text = snapshot.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(snapshot.bytes)) throw new RevertRefused(`${path} is not UTF-8 text, so its hunks are not reverted here.`);
    const next = revertHunks(text, request.patch, request.hunks);
    if (next === null) throw CHANGED(path);
    replace(checkout, path, absolute, snapshot, Buffer.from(next, "utf8"), snapshot.mode, options);
    return;
  }
  if (entry.oldMode === "000000") {
    // A new file: removed, if it still is the reviewed one.
    checkFolders(checkout, path, "refuse");
    stillReviewed(absolute, path, snapshot!);
    unlinkSync(absolute);
    return;
  }
  const committed = Buffer.from((await run(checkout.real, ["cat-file", "blob", entry.oldBlob], { maxBuffer: 256 * 1024 * 1024, bytes: true })).stdout, "latin1");
  if (entry.newMode === "000000") {
    // A deleted file: put back, through real folders only, where nothing has been created since.
    restore(checkout, path, absolute, committed, entry.oldMode, options);
    return;
  }
  replace(checkout, path, absolute, snapshot!, committed, entry.oldMode, options);
}
