/**
 * The first mate's home as files, for the few the plugin itself reads and edits (the suggestions).
 *
 * Every path is relative to the home and is checked twice: lexically (no
 * absolute paths, nothing that normalizes above the home) and on disk, by
 * resolving symlinks and requiring the result to still be inside the home's
 * own real path. The second check is what stops a link the first mate — or a
 * clone under `projects/` — happens to contain from opening the rest of the
 * disk.
 *
 * The first mate writes these same files, so a replacement is refused unless the file still reads
 * exactly as it did (`replaceTextIfUnchanged`), checked both before the new content is staged and
 * again just before it replaces the file. Each write goes to a temporary file that is then renamed,
 * so a crash never leaves half a file for the first mate to read; it takes the replaced file's mode
 * first. Writes to one path run one at a time, so two replacements of the same version cannot both
 * pass the check.
 */
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { serialized } from "./serialize";

/** The largest file the editor opens. */
const MAX_TEXT_BYTES = 1024 * 1024;

/** How much of a file is read to decide whether it is text. */
const SNIFF_BYTES = 8192;

/** Turns a panel path into a normalized relative one, or throws. `""` is the home. */
export function cleanRelative(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (trimmed === "" || trimmed === ".") return "";
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) throw new Error(`"${path}" is not a path inside the home.`);
  const normalized = normalize(trimmed).split(sep).join("/").replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`"${path}" is outside the home.`);
  return normalized === "." ? "" : normalized;
}

/** The directory as the filesystem names it, through symlinks; a path that does not exist is compared as written. */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/**
 * The absolute path for `path`, after resolving symlinks — of the path
 * itself when it exists, of its nearest existing ancestor when it does not
 * (a file about to be created) — and refusing anything that lands outside.
 */
export async function resolveInHome(home: string, path: string): Promise<{ absolute: string; relative: string }> {
  const rel = cleanRelative(path);
  const root = await realpath(home);
  const absolute = join(root, rel);
  let existing = absolute;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (!isInside(root, real)) throw new Error(`"${rel}" leads outside the home.`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return { absolute, relative: rel };
}

/**
 * The plugin's own reads and writes in the home, confined like the rest: each resolves its path with
 * `resolveInHome` first, so a symlink anywhere on the way that leads out of the home is refused rather
 * than followed. A write is a staged rename, which replaces a symlink at the destination instead of
 * writing through it; a creation is exclusive, which never follows one. As with `stageAndReplace`, a
 * link swapped in between the check and the use is not caught.
 */
export async function readInHome(home: string, path: string): Promise<string | null> {
  const { absolute } = await resolveInHome(home, path);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The key writes to one file queue on: its path as written, taken before anything is resolved, so two
 * writes land in the order they were asked for rather than the order their paths resolved in.
 */
function lockKey(home: string, path: string): string {
  return resolve(home, cleanRelative(path));
}

/** Writes the file whatever it holds now; `mode`, when given, is set before it lands. */
export async function writeInHome(home: string, path: string, content: string, mode?: number): Promise<void> {
  await serialized(lockKey(home, path), async () => {
    const { absolute, relative: rel } = await resolveInHome(home, path);
    if (rel === "") throw new Error("The home itself is not a file.");
    await stageAndReplace(absolute, content, () => undefined, {}, mode);
  });
}

/** Writes the file only when nothing is there; says whether it did. */
export async function createInHome(home: string, path: string, content: string): Promise<boolean> {
  const { absolute } = await resolveInHome(home, path);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Removes the file, or the symlink standing where it would be; nothing there is not an error. */
export async function removeInHome(home: string, path: string): Promise<void> {
  const { absolute } = await resolveInHome(home, path);
  await rm(absolute, { force: true });
}

/**
 * The folder at `path` when it is a plain folder at its place in the home — no symlink anywhere on the
 * way, not even to another folder inside the home — or null when there is none. With `create`, it is
 * made first. Anything the plugin lists, runs or prunes by name lives in such a folder, so a link can
 * never send it to another one.
 */
export async function plainFolderInHome(home: string, path: string, create = false): Promise<string | null> {
  const rel = cleanRelative(path);
  if (create) await makeDirInHome(home, rel);
  const absolute = join(await realpath(home), rel);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (real !== absolute) throw new Error(`${rel} is not a plain folder in the home.`);
  if (!(await stat(real)).isDirectory()) throw new Error(`${rel} is not a folder.`);
  return absolute;
}

/** Creates the directory and its parents, then checks the result is still inside the home. */
export async function makeDirInHome(home: string, path: string): Promise<string> {
  const { absolute } = await resolveInHome(home, path);
  await mkdir(absolute, { recursive: true });
  await resolveInHome(home, path);
  return absolute;
}

/** A NUL byte in the first few kilobytes is the usual sign of a file that is not text. */
async function looksBinary(absolute: string): Promise<boolean> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function readTextFile(home: string, path: string) {
  const { absolute, relative: rel } = await resolveInHome(home, path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`"${rel}" is not a file.`);
  const base = { path: rel, size: info.size, modifiedMs: Math.floor(info.mtimeMs) };
  if (info.size > MAX_TEXT_BYTES) return { ...base, content: null, binary: false, tooLarge: true };
  if (await looksBinary(absolute)) return { ...base, content: null, binary: true, tooLarge: false };
  return { ...base, content: await readFile(absolute, "utf8"), binary: false, tooLarge: false };
}

/**
 * A write refused because the file is no longer the version it was checked against: the first mate
 * wrote it, deleted it or created it in between. Callers that can start over from the new version
 * tell it from other failures by its class.
 */
export class FileChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChangedError";
  }
}

/** For tests: runs once the temporary file is written, before the destination is checked again. */
export interface WriteHooks {
  afterStaging?: () => Promise<void>;
}

/**
 * Replaces a text file only if it still reads exactly `expected`, compared by content rather than by
 * modification time, which cannot tell two writes within one millisecond apart. Throws
 * `FileChangedError` when it does not, or when it is gone.
 */
export async function replaceTextIfUnchanged(
  home: string,
  path: string,
  expected: string,
  content: string,
  hooks: WriteHooks = {},
): Promise<void> {
  await serialized(lockKey(home, path), async () => {
    const { absolute, relative: rel } = await resolveInHome(home, path);
    if (rel === "") throw new Error("The home itself is not a file.");
    await stageAndReplace(
      absolute,
      content,
      async (current) => {
        if (current === null) throw new FileChangedError(`"${rel}" was deleted since it was read.`);
        if (!current.isFile()) throw new Error(`"${rel}" is not a file.`);
        if ((await readFile(absolute, "utf8")) !== expected) throw new FileChangedError(`"${rel}" changed since it was read.`);
      },
      hooks,
    );
  });
}

type Current = Stats | null;

async function statIfPresent(absolute: string): Promise<Current> {
  try {
    return await stat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/**
 * Writes `content` to a temporary file beside `absolute` and renames it into place, running `check`
 * on the destination twice: before anything is written, and again once the temporary file is ready,
 * just before the rename. The second check is what catches the first mate writing while this one was
 * staging. What it cannot catch is a write landing between that check and the rename — there is no
 * compare-and-swap rename to close it — so the window is a stat, or a read of a small file, wide.
 */
async function stageAndReplace(
  absolute: string,
  content: string,
  check: (current: Current) => void | Promise<void>,
  hooks: WriteHooks,
  mode?: number,
): Promise<void> {
  const current = await statIfPresent(absolute);
  await check(current);

  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.firstmate-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    // The temporary file has the default mode; the one it replaces keeps its own, so a watch script
    // saved here stays executable. A new file keeps the default.
    if (mode !== undefined) await chmod(temporary, mode);
    else if (current !== null) await chmod(temporary, current.mode & 0o7777);
    await hooks.afterStaging?.();
    await check(await statIfPresent(absolute));
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
