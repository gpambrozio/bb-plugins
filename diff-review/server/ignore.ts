/**
 * Which changed files the Review tab leaves out: generated files, lockfiles and the like. Patterns are
 * gitignore syntax, from the plugin's setting and from the workspace's own `.diffityignore` and
 * `.git/info/diffityignore` (in a linked worktree, the main repository's: `gitInfoParent` in
 * `diff.ts`), the files diffity reads (`src-tauri/src/core/diffignore.rs`), so a repository set up for
 * diffity works unchanged.
 */
import ignore from "ignore";

/** The ignore file in the workspace root, and the one in the repository's `info/`. */
export const WORKSPACE_IGNORE_FILE = ".diffityignore";
export const INFO_IGNORE_FILE = "info/diffityignore";

/**
 * The git dir a `.git` file points at (`gitdir: <path>`), as a linked worktree or a submodule has
 * one; null when the text is not a gitfile.
 */
export function gitfileTarget(text: string): string | null {
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  return match === null ? null : match[1]!;
}

/** Splits a setting or a file into patterns: one per line, blank lines and `#` comments dropped. */
export function patternLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** A test for paths relative to the workspace root; with no patterns, nothing is ignored. */
export function ignoreMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = ignore().add([...patterns]);
  return (path) => {
    const relative = path.replace(/^\.\//, "");
    // `ignore` throws on a path it cannot judge (absolute, `..`); such a path is shown.
    if (relative === "" || relative.startsWith("/") || relative.startsWith("../")) return false;
    return matcher.ignores(relative);
  };
}
