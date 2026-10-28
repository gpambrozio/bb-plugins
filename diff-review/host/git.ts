/**
 * Git in a checkout on the host: the diffs bb's Git plugin does not give (staged, unstaged, ranges).
 * Every command runs `git` with fixed arguments and the revisions the contract allowed, with a timeout
 * and a capped output, and never writes to the repository.
 *
 * The range rules are diffity's (`src-tauri/src/core/diff.rs` and `core/git.rs`,
 * https://github.com/nilbuild/diffity, MIT): `a..b` and `a...b` diff the merge base of a and b against
 * b, and for `a...b` a b already merged into a diffs from where it forked, so a merged PR still shows
 * its changes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { HostDiffSpec } from "../shared/git-spec";
import type { HostDiff, HostDiffFile } from "../shared/host-contract";

/** git's empty tree, the old side of a repository with no commits. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The most patch text sent for one diff, and for one file. */
export const DIFF_MAX_BYTES = 4 * 1024 * 1024;
export const FILE_PATCH_MAX_BYTES = 512 * 1024;
/** The most files a diff lists. */
export const DIFF_MAX_FILES = 3_000;
/** An untracked file larger than this shows no patch. */
const UNTRACKED_MAX_BYTES = 512 * 1024;

export class GitError extends Error {}

/** `bytes`: stdout as latin1, one character per byte, so `Buffer.from(stdout, "latin1")` gives the bytes back. */
/** `input`: written to git's stdin. */
export type RunGit = (
  root: string,
  args: readonly string[],
  options?: { maxBuffer?: number; allowFailure?: boolean; bytes?: boolean; input?: Buffer },
) => Promise<{ stdout: string; ok: boolean }>;

/** Where git is: on PATH, else where macOS and Homebrew put it (a daemon's PATH may be bare). */
const GIT_CANDIDATES = ["git", "/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

export function createRunGit(timeoutMs = 60_000): RunGit {
  let git: string | null = null;
  const attempt = (file: string, root: string, args: readonly string[], maxBuffer: number, encoding: "utf8" | "latin1", input: Buffer | undefined) =>
    new Promise<{ stdout: string; code: number | null; missing: boolean; stderr: string }>((resolve) => {
      // Paths as they are, not octal-quoted, whatever the user's git config says.
      const child = execFile(file, ["-C", root, "-c", "core.quotePath=false", ...args], { encoding, maxBuffer, timeout: timeoutMs, killSignal: "SIGKILL", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
        const overflow = (error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolve({ stdout, code: overflow ? -1 : code, missing: (error as { code?: unknown } | null)?.code === "ENOENT", stderr: overflow ? "output too large" : stderr });
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
  return async (root, args, options = {}) => {
    const maxBuffer = options.maxBuffer ?? DIFF_MAX_BYTES * 2;
    for (const candidate of git === null ? GIT_CANDIDATES : [git]) {
      const result = await attempt(candidate, root, args, maxBuffer, options.bytes === true ? "latin1" : "utf8", options.input);
      if (result.missing) continue;
      git = candidate;
      if (result.code === 0) return { stdout: result.stdout, ok: true };
      if (options.allowFailure === true) return { stdout: result.stdout, ok: false };
      const last = result.stderr.trim().split("\n").at(-1) ?? "";
      throw new GitError(`git ${args[0]} failed: ${last !== "" ? last : result.code === null ? "it timed out or was stopped" : `exit ${String(result.code)}`}`);
    }
    throw new GitError("git was not found on this machine.");
  };
}

async function verify(run: RunGit, root: string, revision: string): Promise<string | null> {
  const result = await run(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

async function mergeBase(run: RunGit, root: string, a: string, b: string): Promise<string | null> {
  const result = await run(root, ["merge-base", a, b], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

/** For `base...head` when head is already merged into base: the merge base of head and where base was before the merge. */
async function mergedForkPoint(run: RunGit, root: string, base: string, head: string): Promise<string | null> {
  const merges = await run(root, ["rev-list", "--first-parent", "--ancestry-path", "--reverse", `${head}..${base}`], { allowFailure: true });
  const merge = merges.ok ? merges.stdout.split("\n")[0]?.trim() : undefined;
  if (merge === undefined || merge === "") return null;
  const before = await verify(run, root, `${merge}^1`);
  if (before === null || before === head) return null;
  return mergeBase(run, root, before, head);
}

interface Plan {
  args: string[];
  untracked: boolean;
  baseSha: string | null;
  headSha: string | null;
}

export async function plan(run: RunGit, root: string, spec: HostDiffSpec): Promise<Plan> {
  const head = await verify(run, root, "HEAD");
  switch (spec.kind) {
    case "staged":
      return { args: ["--cached", head ?? EMPTY_TREE], untracked: false, baseSha: head, headSha: null };
    case "unstaged":
      return { args: [], untracked: true, baseSha: null, headSha: null };
    case "range": {
      const left = await verify(run, root, spec.from);
      if (left === null) throw new GitError(`Unknown revision '${spec.from}'.`);
      const right = await verify(run, root, spec.to);
      if (right === null) throw new GitError(`Unknown revision '${spec.to}'.`);
      let base = await mergeBase(run, root, left, right);
      if (base === null) throw new GitError(`'${spec.from}' and '${spec.to}' have no common ancestor.`);
      if (spec.symmetric && base === right && left !== right) base = (await mergedForkPoint(run, root, left, right)) ?? base;
      return { args: [base, right], untracked: false, baseSha: base, headSha: right };
    }
  }
}

const BASE_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "-M"];

const STATUS_KINDS: Record<string, HostDiffFile["changeKind"]> = { A: "added", C: "copied", D: "deleted", M: "modified", R: "renamed", T: "type_changed" };

/** `--name-status -z`: status, then one path (two for a rename or copy). */
export function parseNameStatus(text: string): { kind: HostDiffFile["changeKind"]; previousPath: string | null; path: string }[] {
  const fields = text.split("\0");
  const entries: { kind: HostDiffFile["changeKind"]; previousPath: string | null; path: string }[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (status === undefined || status === "") continue;
    const letter = status[0]!;
    const kind = STATUS_KINDS[letter] ?? "modified";
    if (letter === "R" || letter === "C") {
      const previousPath = fields[index++] ?? "";
      const path = fields[index++] ?? "";
      entries.push({ kind, previousPath, path });
    } else {
      entries.push({ kind, previousPath: null, path: fields[index++] ?? "" });
    }
  }
  return entries;
}

/** `--numstat -z`: added, removed (`-` for binary) and the path, or for a rename the two paths after. */
export function parseNumstat(text: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const fields = text.split("\0");
  for (let index = 0; index < fields.length; ) {
    const head = fields[index++];
    if (head === undefined || head === "") continue;
    const [added, removed, path] = head.split("\t");
    const binary = added === "-" || removed === "-";
    const entry = { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(removed), binary };
    if (path === undefined || path === "") {
      index++; // the old path
      const newPath = fields[index++] ?? "";
      counts.set(newPath, entry);
    } else counts.set(path, entry);
  }
  return counts;
}

/** A unified patch split into each file's section, keyed by its new path (`+++ b/…`, or `a/…` for a deletion). */
export function splitPatch(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  for (let match = pattern.exec(patch); match !== null; match = pattern.exec(patch)) starts.push(match.index);
  for (let index = 0; index < starts.length; index++) {
    const section = patch.slice(starts[index], starts[index + 1] ?? patch.length);
    const path = sectionPath(section);
    if (path !== null) sections.set(path, section);
  }
  return sections;
}

/** A path git C-quoted (`"a\\tb"`, `"\\303\\251"`): escapes and octal bytes, decoded as UTF-8. */
export function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const inner = path.slice(1, -1);
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = inner[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(inner.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(named[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A `---`/`+++` path: git puts a tab after a name with a space in it. */
function headerPath(raw: string): string {
  return unquote(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
}

function sectionPath(section: string): string | null {
  const plus = /^\+\+\+ (?:b\/(.*)|("b\/.*"\t?))$/m.exec(section);
  if (plus !== null && plus[1] !== undefined) return headerPath(plus[1]);
  if (plus !== null && plus[2] !== undefined) return headerPath(plus[2]).slice(2);
  const rename = /^rename to (.*)$/m.exec(section) ?? /^copy to (.*)$/m.exec(section);
  if (rename !== null) return unquote(rename[1]!);
  const minus = /^--- (?:a\/(.*)|("a\/.*"\t?))$/m.exec(section);
  if (minus !== null && minus[1] !== undefined) return headerPath(minus[1]);
  if (minus !== null && minus[2] !== undefined) return headerPath(minus[2]).slice(2);
  const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(section);
  return header === null ? null : header[2]!;
}

/** A new file's patch, as `git diff --no-index` would show it. */
export function newFilePatch(path: string, content: string): string {
  const lines = content === "" ? [] : content.split("\n");
  const endsWithNewline = content.endsWith("\n");
  if (endsWithNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!endsWithNewline && lines.length > 0) body.push("\\ No newline at end of file");
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, ...(lines.length === 0 ? [] : [`@@ -0,0 +1,${lines.length} @@`, ...body]), ""].join("\n");
}

export async function diff(run: RunGit, root: string, spec: HostDiffSpec, ignoreWhitespace: boolean): Promise<HostDiff> {
  const { args, untracked, baseSha, headSha } = await plan(run, root, spec);
  const extra = ignoreWhitespace ? ["-w"] : [];
  const [names, numbers, full] = await Promise.all([
    run(root, [...BASE_ARGS, "--name-status", "-z", ...args]),
    run(root, [...BASE_ARGS, "--numstat", "-z", ...extra, ...args]),
    // A diff too large to read whole (a vendored tree, a lockfile) lists its files without patches.
    run(root, [...BASE_ARGS, ...extra, ...args], { maxBuffer: DIFF_MAX_BYTES * 4 }).catch((error: unknown) => {
      if (error instanceof GitError && error.message.includes("output too large")) return null;
      throw error;
    }),
  ]);
  const counts = parseNumstat(numbers.stdout);
  const sections = full === null ? new Map<string, string>() : splitPatch(full.stdout);
  const files: HostDiffFile[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of parseNameStatus(names.stdout)) {
    if (files.length >= DIFF_MAX_FILES) {
      truncated = true;
      break;
    }
    const count = counts.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    const section = sections.get(entry.path) ?? null;
    // With whitespace hidden, a file whose only changes were whitespace has no patch left (a mode
    // change still shows).
    if (ignoreWhitespace && section !== null && !section.includes("\n@@") && !/^(old|new) mode /m.test(section) && !count.binary && entry.kind === "modified") continue;
    const tooLarge = full === null || (section !== null && (section.length > FILE_PATCH_MAX_BYTES || bytes + section.length > DIFF_MAX_BYTES));
    if (section !== null && !tooLarge) bytes += section.length;
    files.push({
      path: entry.path,
      previousPath: entry.previousPath,
      changeKind: entry.kind,
      additions: count.additions,
      deletions: count.deletions,
      binary: count.binary,
      untracked: false,
      patch: count.binary || tooLarge ? null : section,
      tooLarge,
    });
  }
  if (untracked) {
    const listed = await run(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of listed.stdout.split("\0").filter((entry) => entry !== "")) {
      if (files.length >= DIFF_MAX_FILES) {
        truncated = true;
        break;
      }
      files.push(await untrackedFile(root, path, bytes, (added) => (bytes += added)));
    }
  }
  return { files, truncated, baseSha, headSha };
}

async function untrackedFile(root: string, path: string, used: number, use: (bytes: number) => void): Promise<HostDiffFile> {
  const base = { path, previousPath: null, changeKind: "added" as const, deletions: 0, untracked: true };
  // A symlink shows as git shows it, its target as the content; it is never followed.
  const info = await lstat(join(root, path)).catch(() => null);
  if (info !== null && info.isSymbolicLink()) {
    const target = await readlink(join(root, path)).catch(() => "");
    const patch = newFilePatch(path, target).replace("new file mode 100644", "new file mode 120000");
    use(patch.length);
    return { ...base, additions: 1, binary: false, patch, tooLarge: false };
  }
  if (info === null || !info.isFile() || info.size > UNTRACKED_MAX_BYTES || used + info.size > DIFF_MAX_BYTES) {
    return { ...base, additions: 0, binary: false, patch: null, tooLarge: true };
  }
  const data = await readFile(join(root, path));
  if (data.includes(0)) return { ...base, additions: 0, binary: true, patch: null, tooLarge: false };
  const content = data.toString("utf8");
  const patch = newFilePatch(path, content);
  use(patch.length);
  const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return { ...base, additions: lines, binary: false, patch, tooLarge: false };
}

/** A fingerprint of the index against HEAD: its staged modes and blobs, path by path. */
export async function indexState(run: RunGit, root: string): Promise<string> {
  const head = (await verify(run, root, "HEAD")) ?? EMPTY_TREE;
  const staged = await run(root, ["diff", "--no-ext-diff", "--cached", "--raw", "--no-abbrev", "-z", head]);
  return createHash("sha256").update(staged.stdout).digest("hex");
}
