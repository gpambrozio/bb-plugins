/**
 * Finding a repository's Claude Code sessions. Claude Code writes each session to
 * `<config>/projects/<slug of its working directory>/<session id>.jsonl` (2.1.326), so one
 * repository's sessions are spread over several folders:
 *
 * - the main checkout's folder, `slug(checkout)`;
 * - one per bb worktree, `slug(<bb data>/plugins/environment-git-worktree/host-data/worktrees/<thread id>-<n>/<repo>)`.
 *   The folder outlives the worktree. The thread id in its name says which project it belongs to,
 *   and when bb no longer knows the thread, the trailing repository name does (see
 *   `server/projects.ts`);
 * - one per Claude Code worktree, `slug(<checkout>/.claude/worktrees/<name>)`, which starts with the
 *   checkout's own slug followed by `--claude-worktrees-`.
 *
 * Only top-level `*.jsonl` files are sessions; subfolders hold subagent transcripts and tool output.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { projectSlug } from "./slug";

/** What a bb worktree's transcript folder name says: `...-worktrees-thr-<id>-<n>-<repo slug>`. */
const BB_WORKTREE_FOLDER = /-environment-git-worktree-host-data-worktrees-thr-([a-z0-9]+)-(\d+)-(.+)$/;

export interface WorktreeFolder {
  name: string;
  threadId: string;
  /** The slug of the worktree's folder name, which is the checkout's folder name. */
  repoSlug: string;
}

export function parseWorktreeFolder(name: string): WorktreeFolder | null {
  const match = BB_WORKTREE_FOLDER.exec(name);
  if (!match) return null;
  return { name, threadId: `thr_${match[1]}`, repoSlug: match[3] };
}

/** The folder names under `projectsDir`, or none when it does not exist. */
export function listTranscriptFolders(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The slugs Claude Code may have used for a checkout: its path as bb knows it, and its real path. */
export function checkoutSlugs(checkout: string, realCheckout: string | null): string[] {
  const slugs = new Set([projectSlug(checkout)]);
  if (realCheckout) slugs.add(projectSlug(realCheckout));
  return [...slugs];
}

/**
 * The checkout's own folders among `folders`: its slug, and the Claude Code worktrees under it.
 * bb worktree folders are matched by thread id, not here.
 */
export function checkoutFolders(folders: readonly string[], slugs: readonly string[]): string[] {
  return folders.filter((name) => slugs.some((slug) => name === slug || name.startsWith(`${slug}--claude-worktrees-`)));
}

export interface SessionFile {
  sessionId: string;
  path: string;
  folder: string;
  mtimeMs: number;
  size: number;
}

export function listSessions(projectsDir: string, folder: string): SessionFile[] {
  const dir = path.join(projectsDir, folder);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const stats = statSync(file);
      if (!stats.isFile()) continue;
      sessions.push({ sessionId: name.slice(0, -".jsonl".length), path: file, folder, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
      // Removed while listing.
    }
  }
  return sessions;
}

/** Only these lines are parsed; the rest of a transcript is never read into memory whole. */
const TITLE_LINE = /^\{"type":"(custom-title|ai-title)"/;
const MAX_TITLE_LENGTH = 120;
/** Titles are looked for in the first and last this many bytes, so a huge transcript costs little. */
export const TITLE_WINDOW_BYTES = 1024 * 1024;

async function titleLines(file: string, start: number, end: number, found: { custom: string | null; ai: string | null }): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8", start, end }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const match = TITLE_LINE.exec(line);
      if (!match) continue;
      try {
        const record = JSON.parse(line) as { customTitle?: unknown; aiTitle?: unknown };
        if (match[1] === "custom-title" && typeof record.customTitle === "string") found.custom = record.customTitle;
        if (match[1] === "ai-title" && typeof record.aiTitle === "string") found.ai = record.aiTitle;
      } catch {
        // A line cut by the window, or still being written.
      }
    }
  } finally {
    lines.close();
  }
}

/**
 * A session's title: the last title the user gave it (`custom-title`), else the last one Claude Code
 * wrote (`ai-title`), else null. Reads the first and last `TITLE_WINDOW_BYTES` a line at a time and
 * parses only title lines.
 */
export async function sessionTitle(file: string): Promise<string | null> {
  const found: { custom: string | null; ai: string | null } = { custom: null, ai: null };
  try {
    const size = statSync(file).size;
    if (size <= 2 * TITLE_WINDOW_BYTES) await titleLines(file, 0, Math.max(0, size - 1), found);
    else {
      await titleLines(file, 0, TITLE_WINDOW_BYTES - 1, found);
      await titleLines(file, size - TITLE_WINDOW_BYTES, size - 1, found);
    }
  } catch {
    return null;
  }
  const title = (found.custom ?? found.ai)?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}
