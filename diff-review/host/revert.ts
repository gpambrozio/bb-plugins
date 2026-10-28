/**
 * Reverting an uncommitted change in the checkout, on the machine that holds it: a whole file back to
 * `HEAD` (a new file removed, a deleted one put back), or some of its hunks.
 *
 * It acts only on the version the user reviewed. The tab sends the file's revision as bb's Git plugin
 * listed it, `oldMode:oldBlob:newMode:newBlob` with the working copy's blob hashed, and this recomputes
 * that revision from the checkout, git's blob hash in-process, and refuses when it differs. The last
 * check runs synchronously just before the file is replaced (a write to a temporary file, then a
 * rename) or removed, with no await in between, so a save another process makes in that same instant
 * is the only change it can miss.
 *
 * Symlinks and submodules are refused: bb's own file reads and writes follow a link, and reverting
 * one here would write through it.
 */
import { createHash } from "node:crypto";
import { closeSync, chmodSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { revertHunks } from "../shared/revert";
import type { RunGit } from "./git";

export class RevertRefused extends Error {}

const ZERO = /^0+$/;

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

/** git's blob id of `bytes`, as `git hash-object` gives it without filters. */
export function blobHash(bytes: Buffer, format: "sha1" | "sha256" = "sha1"): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

interface Entry {
  oldMode: string;
  oldBlob: string;
  newMode: string;
  newBlob: string;
}

function inside(root: string, path: string): string {
  const absolute = join(root, path);
  const rel = relative(root, absolute);
  if (path === "" || isAbsolute(path) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new RevertRefused(`${path} is not a file of this workspace.`);
  return absolute;
}

/** The working copy's bytes and mode, or null when it is gone; a symlink's bytes are its target. */
function working(absolute: string): { bytes: Buffer; mode: string } | null {
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

async function entryOf(run: RunGit, root: string, path: string, absolute: string): Promise<Entry> {
  const raw = await run(root, ["diff", "--no-ext-diff", "--raw", "--no-abbrev", "-z", "HEAD", "--", path], { allowFailure: true });
  if (!raw.ok) throw new RevertRefused("This workspace has no commit to revert to.");
  const head = raw.stdout.split("\0")[0] ?? "";
  const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(head);
  if (match !== null) return { oldMode: match[1]!, newMode: match[2]!, oldBlob: match[3]!, newBlob: match[4]! };
  const untracked = await run(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  if (!untracked.stdout.split("\0").includes(path)) throw new RevertRefused(`${path} has no uncommitted change now.`);
  const file = working(absolute);
  if (file === null) throw new RevertRefused(`${path} has no uncommitted change now.`);
  const zero = "0".repeat(40);
  return { oldMode: "000000", oldBlob: zero, newMode: file.mode, newBlob: zero };
}

function revisionOf(entry: Entry, current: { bytes: Buffer } | null, format: "sha1" | "sha256"): string {
  const newBlob = ZERO.test(entry.newBlob) && entry.newMode !== "000000" && current !== null ? blobHash(current.bytes, format) : entry.newBlob;
  return `${entry.oldMode}:${entry.oldBlob}:${entry.newMode}:${newBlob}`;
}

const CHANGED = (path: string) => new RevertRefused(`${path} changed since the diff was loaded; reload and try again.`);

/** Throws unless the working copy still is the bytes `expected` names (synchronous: no await). */
function stillReviewed(absolute: string, path: string, expected: string, format: "sha1" | "sha256"): void {
  const now = working(absolute);
  if (now === null || now.mode === "120000" || now.mode === "040000" || blobHash(now.bytes, format) !== expected) throw CHANGED(path);
}

/** Replaces the file with `bytes` if it still is the reviewed version. */
function replace(absolute: string, path: string, expected: string, bytes: Buffer, mode: string, format: "sha1" | "sha256"): void {
  const temporary = join(dirname(absolute), `.diff-review-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
  chmodSync(temporary, mode === "100755" ? 0o755 : 0o644);
  try {
    stillReviewed(absolute, path, expected, format);
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
  const format = (await run(root, ["rev-parse", "--show-object-format"], { allowFailure: true })).stdout.trim() === "sha256" ? "sha256" : "sha1";
  const entry = await entryOf(run, root, path, absolute);
  return revisionOf(entry, entry.newMode === "000000" ? null : working(absolute), format);
}

export async function revert(run: RunGit, request: RevertRequest): Promise<void> {
  const { root, path } = request;
  const absolute = inside(root, path);
  const format = (await run(root, ["rev-parse", "--show-object-format"], { allowFailure: true })).stdout.trim() === "sha256" ? "sha256" : "sha1";
  const entry = await entryOf(run, root, path, absolute);
  if ([entry.oldMode, entry.newMode].some((mode) => mode === "120000" || mode === "160000")) {
    throw new RevertRefused(`${path} is a symlink or a submodule, which is not reverted here; use git.`);
  }
  const current = entry.newMode === "000000" ? null : working(absolute);
  if (revisionOf(entry, current, format) !== request.revision) throw CHANGED(path);
  const reviewed = current === null ? null : blobHash(current.bytes, format);

  if (request.hunks !== null) {
    if (current === null || reviewed === null || request.patch === null) throw new RevertRefused(`${path} has no hunks to revert; revert the whole file.`);
    const text = current.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(current.bytes)) throw new RevertRefused(`${path} is not UTF-8 text, so its hunks are not reverted here.`);
    const next = revertHunks(text, request.patch, request.hunks);
    if (next === null) throw CHANGED(path);
    replace(absolute, path, reviewed, Buffer.from(next, "utf8"), current.mode, format);
    return;
  }
  if (entry.oldMode === "000000") {
    // A new file: removed, if it still is the reviewed one.
    stillReviewed(absolute, path, reviewed!, format);
    unlinkSync(absolute);
    return;
  }
  const committed = Buffer.from((await run(root, ["cat-file", "blob", entry.oldBlob], { maxBuffer: 256 * 1024 * 1024, bytes: true })).stdout, "latin1");
  if (entry.newMode === "000000") {
    // A deleted file: put back, only where nothing has been created since.
    mkdirSync(dirname(absolute), { recursive: true });
    let fd;
    try {
      fd = openSync(absolute, "wx", entry.oldMode === "100755" ? 0o755 : 0o644);
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
  replace(absolute, path, reviewed!, committed, entry.oldMode, format);
}
