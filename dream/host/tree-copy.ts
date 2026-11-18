/**
 * A faithful copy of one commit's tree: every tracked file as git stores it, and nothing else.
 *
 * `git archive` is a release-packaging tool, not a copy: it applies the repository's own
 * `.gitattributes`, so `export-ignore` silently leaves tracked files out (a `docs/` or a `CLAUDE.md` a
 * dream needs) and `export-subst` expands placeholders, which can turn a few KB in git into gigabytes
 * on disk past any limit counted from blob sizes. So the tree is listed with `git ls-tree` and each
 * blob read raw with `git cat-file --batch`, which applies no attribute, filter or substitution.
 *
 * - **A real limit.** `maxBytes` is checked against the bytes actually written, as they are written,
 *   and `maxEntries` against the files; going past either stops git and throws `TreeTooLargeError`.
 *   The caller writes into a fresh folder and deletes it on any failure.
 * - **Only inside the target.** A path with an empty, `.` or `..` part, or a `.git` part (any case), is
 *   refused, as git itself refuses to check one out. Every folder on the way is made here, one at a
 *   time, and checked to be a real folder, never a link; files are created exclusively (`wx`). Symbolic
 *   links are made last, so no file is ever written through one.
 * - **The repository is only read**: `ls-tree` and `cat-file`, with `GIT_OPTIONAL_LOCKS=0`.
 *
 * Submodules (commit entries) are not copied; their folder is left out.
 */
import { spawn } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, symlinkSync, writeSync } from "node:fs";
import path from "node:path";

import type { Git } from "./code";

const READ_TIMEOUT_MS = 300_000;
/** A symbolic link's target longer than this is refused; real ones are far shorter. */
const MAX_LINK_BYTES = 4096;

export class TreeTooLargeError extends Error {}
export class UnsafeTreeError extends Error {}

interface Entry {
  mode: string;
  object: string;
  size: number;
  parts: string[];
}

function checkedParts(file: string): string[] {
  const parts = file.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.normalize("NFC").toLowerCase() === ".git") throw new UnsafeTreeError(`the tree has an unsafe path: ${JSON.stringify(file)}`);
  }
  return parts;
}

/** The commit's blobs (regular files and links) as `ls-tree` lists them, with their sizes. */
export async function treeEntries(git: Git, commit: string): Promise<Entry[]> {
  const result = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", commit], { timeoutMs: READ_TIMEOUT_MS });
  if (result.code !== 0) throw new Error("git ls-tree failed");
  const entries: Entry[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`git ls-tree printed an unexpected line: ${JSON.stringify(record.slice(0, 200))}`);
    const [, mode, type, object, size, file] = match;
    if (type !== "blob") continue;
    entries.push({ mode, object, size: Number(size), parts: checkedParts(file) });
  }
  return entries;
}

/** Makes each folder of `parts` under `root`, one at a time, refusing anything that is not a real folder. */
function parentOf(root: string, parts: string[]): string {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(current).isDirectory()) throw new UnsafeTreeError(`${path.relative(root, current)} is not a folder in the copy`);
  }
  return current;
}

/**
 * Reads the blobs of `entries` in order from one `git cat-file --batch`, handing each one's bytes to
 * `sink` as they arrive. Answers once every blob was read; rejects, stopping git, on any surprise.
 */
function readBlobs(
  repo: string,
  gitPath: string,
  entries: readonly Entry[],
  sink: { begin(index: number, size: number): void; data(chunk: Buffer): void; end(): void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, ["-C", repo, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    let settled = false;
    let stderr = "";
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("git cat-file took too long")), READ_TIMEOUT_MS);
    timer.unref?.();

    let index = 0;
    let header = Buffer.alloc(0);
    let remaining = -1; // Bytes of the current blob still to come; -1 while reading a header.
    let newline = false; // The newline after a blob's bytes is still to come.
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (newline) {
            if (chunk[offset] !== 0x0a) throw new Error("git cat-file printed an unexpected byte after a blob");
            newline = false;
            offset += 1;
            sink.end();
            index += 1;
            if (index === entries.length) {
              child.stdin.end();
              return finish();
            }
            continue;
          }
          if (remaining < 0) {
            const end = chunk.indexOf(0x0a, offset);
            const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
            header = Buffer.concat([header, part]);
            if (header.length > 512) throw new Error("git cat-file printed an unexpected header");
            if (end < 0) return;
            offset = end + 1;
            const text = header.toString("utf8");
            header = Buffer.alloc(0);
            const entry = entries[index];
            const match = /^([0-9a-f]+) blob (\d+)$/.exec(text);
            if (!match || match[1] !== entry.object) throw new Error(`git cat-file answered ${JSON.stringify(text)} for ${entry.object}`);
            remaining = Number(match[2]);
            sink.begin(index, remaining);
            if (remaining === 0) {
              remaining = -1;
              newline = true;
            }
            continue;
          }
          const take = Math.min(remaining, chunk.length - offset);
          sink.data(chunk.subarray(offset, offset + take));
          offset += take;
          remaining -= take;
          if (remaining === 0) {
            remaining = -1;
            newline = true;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`git cat-file ended early (${code ?? "killed"}): ${stderr.trim()}`)));
    child.stdin.on("error", () => undefined);
    child.stdin.end(entries.map((entry) => `${entry.object}\n`).join(""));
  });
}

/**
 * Writes the tree of `commit` in `repo` into `target`, which must not exist yet. Throws
 * `TreeTooLargeError` past `maxBytes` written or `maxEntries` files, `UnsafeTreeError` for a path that
 * would leave the folder; the caller removes `target` on any throw.
 */
export async function copyTree(input: { git: Git; repo: string; commit: string; target: string; maxBytes: number; maxEntries: number; gitPath?: string }): Promise<{ files: number; bytes: number }> {
  const entries = await treeEntries(input.git, input.commit);
  if (entries.length > input.maxEntries) throw new TreeTooLargeError(`${entries.length} files, over the ${input.maxEntries} a copy may hold`);
  const listed = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (listed > input.maxBytes) throw new TreeTooLargeError(`${Math.round(listed / 1048576)} MB, over the ${Math.round(input.maxBytes / 1048576)} MB a copy may hold`);
  mkdirSync(input.target);
  if (entries.length === 0) return { files: 0, bytes: 0 };

  let written = 0;
  let fd: number | null = null;
  let link: Buffer[] | null = null;
  let linkBytes = 0;
  const links: Array<{ parts: string[]; target: string }> = [];
  let current: Entry | null = null;
  const charge = (bytes: number) => {
    written += bytes;
    if (written > input.maxBytes) throw new TreeTooLargeError(`more than the ${Math.round(input.maxBytes / 1048576)} MB a copy may hold`);
  };
  try {
    await readBlobs(input.repo, input.gitPath ?? "git", entries, {
      begin(index) {
        current = entries[index];
        if (current.mode === "120000") {
          link = [];
          linkBytes = 0;
          return;
        }
        const parent = parentOf(input.target, current.parts);
        fd = openSync(path.join(parent, current.parts[current.parts.length - 1]), "wx", 0o644);
      },
      data(chunk) {
        charge(chunk.length);
        if (link !== null) {
          linkBytes += chunk.length;
          if (linkBytes > MAX_LINK_BYTES) throw new UnsafeTreeError("a symbolic link's target is too long");
          link.push(Buffer.from(chunk));
          return;
        }
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(fd as number, chunk, offset, chunk.length - offset);
      },
      end() {
        const entry = current as Entry;
        if (link !== null) {
          links.push({ parts: entry.parts, target: Buffer.concat(link).toString("utf8") });
          link = null;
          return;
        }
        closeSync(fd as number);
        fd = null;
        if (entry.mode === "100755") chmodSync(path.join(input.target, ...entry.parts), 0o755);
      },
    });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  // Links last, so no file above was written through one; each one's folders are checked the same way.
  for (const entry of links) symlinkSync(entry.target, path.join(parentOf(input.target, entry.parts), entry.parts[entry.parts.length - 1]));
  return { files: entries.length, bytes: written };
}
