/**
 * The deterministic triggers (report v2 §1.3, T1–T5): what a finished turn did, read from data, turned
 * into candidate offers. No model is asked anything. Each topic is built from a commit subject, a path
 * or a pull request title, never written.
 *
 * Priority, highest first: a merged pull request, a commit, a schema change, new files, a streak.
 */
import ignore, { type Ignore } from "ignore";

import type { Refs, TriggerKind } from "../shared/types";

export interface Commit {
  sha: string;
  subject: string;
}

/** A file a commit touched, as the Git plugin lists it (`A` added, `M` modified, …). */
export interface CommittedFile {
  path: string;
  status: string;
}

/** One `fileChange` change from the turn's event log, its path already relative to the workspace. */
export interface FileChange {
  kind: "add" | "update" | "delete";
  path: string;
}

/** What one finished turn did, as far as the plugin could read it. */
export interface TurnFacts {
  /** The turn's new commits, oldest first; empty when HEAD did not move or the move is not this turn's. */
  commits: Commit[];
  committedFiles: CommittedFile[];
  fileChanges: FileChange[];
  /** Set when the thread's pull request went from open or draft to merged since the last read. */
  mergedPullRequest: { url: string; title: string } | null;
  /** Turns with file changes since the last offer in this thread, this one included. */
  changedTurnsSinceOffer: number;
  threadTitle: string;
}

export interface EnabledTriggers {
  commit: boolean;
  newFiles: boolean;
  schema: boolean;
  prMerged: boolean;
  streak: boolean;
}

export interface Candidate {
  trigger: Exclude<TriggerKind, "manual">;
  topic: string;
  refs: Refs;
}

export const TRIGGER_PRIORITY: readonly Candidate["trigger"][] = ["pr-merged", "commit", "schema", "new-files", "streak"];

/** gitignore-style rules over workspace-relative paths. Blank lines and `#` comments are skipped. */
export class PathRules {
  private readonly matcher: Ignore;
  readonly empty: boolean;

  constructor(patterns: string) {
    const lines = patterns
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    this.empty = lines.length === 0;
    this.matcher = ignore().add(lines);
  }

  matches(path: string): boolean {
    if (this.empty) return false;
    const relative = path.replace(/^\.?\/+/, "");
    if (relative === "" || relative.startsWith("../")) return false;
    try {
      return this.matcher.ignores(relative);
    } catch {
      return false;
    }
  }
}

/**
 * A `fileChange` path made relative to the workspace. Providers report absolute paths, and on macOS
 * one of them reports `/private/var/…` for a workspace bb knows as `/var/…`, so both spellings of the
 * root are tried. A path outside the workspace gives null; a relative path is kept as it is.
 */
export function relativize(path: string, root: string | null): string | null {
  if (!path.startsWith("/")) return path.replace(/^\.\/+/, "");
  if (root === null) return null;
  const base = root.replace(/\/+$/, "");
  const roots = new Set([base, base.startsWith("/private/") ? base.slice("/private".length) : `/private${base}`]);
  for (const candidate of roots) {
    if (path.startsWith(`${candidate}/`)) return path.slice(candidate.length + 1);
  }
  return null;
}

function quoted(text: string): string {
  return `"${text.length > 120 ? `${text.slice(0, 117)}…` : text}"`;
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 2).map((path) => `\`${path}\``);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(" and ")} and ${more} more` : shown.join(" and ");
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** New source files: added in a commit or by an edit tool, minus what `exclude` rules out. */
export function newSourceFiles(facts: Pick<TurnFacts, "committedFiles" | "fileChanges">, exclude: PathRules): string[] {
  const added = [
    ...facts.committedFiles.filter((file) => file.status.startsWith("A")).map((file) => file.path),
    ...facts.fileChanges.filter((change) => change.kind === "add").map((change) => change.path),
  ];
  return unique(added).filter((path) => !exclude.matches(path));
}

/** Changed paths that match the schema rules, from commits and edits alike. */
export function schemaPaths(facts: Pick<TurnFacts, "committedFiles" | "fileChanges">, schema: PathRules): string[] {
  const changed = [...facts.committedFiles.map((file) => file.path), ...facts.fileChanges.map((change) => change.path)];
  return unique(changed).filter((path) => schema.matches(path));
}

/** Every trigger the turn sets off, highest priority first. */
export function candidates(
  facts: TurnFacts,
  enabled: EnabledTriggers,
  rules: { exclude: PathRules; schema: PathRules },
  streakTurns: number,
): Candidate[] {
  const found: Candidate[] = [];
  if (enabled.prMerged && facts.mergedPullRequest !== null) {
    found.push({ trigger: "pr-merged", topic: quoted(facts.mergedPullRequest.title), refs: { prUrl: facts.mergedPullRequest.url } });
  }
  if (enabled.commit && facts.commits.length > 0) {
    const first = facts.commits[0]!;
    const more = facts.commits.length - 1;
    found.push({
      trigger: "commit",
      topic: `${quoted(first.subject)}${more > 0 ? ` and ${more} more` : ""}`,
      refs: { commits: facts.commits.slice(0, 10) },
    });
  }
  if (enabled.schema) {
    const paths = schemaPaths(facts, rules.schema);
    if (paths.length > 0) found.push({ trigger: "schema", topic: `the schema change in ${listPaths(paths)}`, refs: { paths: paths.slice(0, 20) } });
  }
  if (enabled.newFiles) {
    const paths = newSourceFiles(facts, rules.exclude);
    if (paths.length > 0) found.push({ trigger: "new-files", topic: `the new ${listPaths(paths)}`, refs: { paths: paths.slice(0, 20) } });
  }
  if (enabled.streak && facts.changedTurnsSinceOffer >= streakTurns) {
    found.push({ trigger: "streak", topic: quoted(facts.threadTitle || "this thread's work"), refs: {} });
  }
  return found.sort((a, b) => TRIGGER_PRIORITY.indexOf(a.trigger) - TRIGGER_PRIORITY.indexOf(b.trigger));
}
