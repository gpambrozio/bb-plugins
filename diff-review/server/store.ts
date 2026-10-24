/**
 * The plugin's own SQLite: review sessions, threads, comments and sends. The tables follow diffity's
 * store (https://github.com/nilbuild/diffity, `src-tauri/src/core/store.rs`, MIT) — a session per
 * workspace and view, threads with a file, side, line range, status, severity and anchor text, and
 * comments by the user or an agent — plus `sends`, the ledger of which threads went to which bb thread.
 *
 * `MIGRATIONS` is append-only: bb records each statement's index as applied, so a shipped statement is
 * never edited or reordered, only followed by new ones.
 */
import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import type { AuthorType, DeliveryState, ReviewComment, ReviewThread, Run, RunKind, RunStatus, Severity, Side, ThreadStatus } from "../shared/types";

export const MIGRATIONS: string[] = [
  `CREATE TABLE review_sessions (
     id TEXT PRIMARY KEY,
     environment_id TEXT NOT NULL,
     target_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (environment_id, target_key)
   )`,
  `CREATE TABLE review_threads (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     file_path TEXT NOT NULL,
     side TEXT CHECK (side IN ('old', 'new')),
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
     severity TEXT CHECK (severity IN ('must-fix', 'suggestion', 'nit', 'question')),
     anchor_content TEXT,
     send_id TEXT REFERENCES sends(id),
     delivery TEXT CHECK (delivery IN ('sent', 'answered', 'no_reply')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX review_threads_session ON review_threads(session_id)`,
  `CREATE TABLE review_comments (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
     author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
     author_name TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     edited_at INTEGER
   )`,
  `CREATE INDEX review_comments_thread ON review_comments(thread_id)`,
  `CREATE TABLE sends (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     bb_thread_id TEXT NOT NULL,
     note TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX sends_bb_thread ON sends(bb_thread_id)`,
  // 0.2.0: AI runs.
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('review', 'mention', 'fix')),
     bb_thread_id TEXT,
     review_thread_id TEXT REFERENCES review_threads(id) ON DELETE SET NULL,
     focus TEXT,
     provider_id TEXT NOT NULL,
     model TEXT,
     status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'closed')),
     summary TEXT,
     baseline TEXT,
     changed_files TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE INDEX runs_session ON runs(session_id)`,
  `CREATE INDEX runs_bb_thread ON runs(bb_thread_id)`,
  // Runs start as children of the thread under review.
  `ALTER TABLE runs ADD COLUMN parent_thread_id TEXT`,
];

export interface Session {
  id: string;
  environmentId: string;
  targetKey: string;
}

export interface NewThread {
  sessionId: string;
  filePath: string;
  side: Side | null;
  startLine: number;
  endLine: number;
  severity: Severity | null;
  anchorContent: string | null;
  body: string;
}

export interface NewComment {
  threadId: string;
  authorType: AuthorType;
  authorName: string;
  body: string;
}

interface ThreadRow {
  id: string;
  session_id: string;
  file_path: string;
  side: Side | null;
  start_line: number;
  end_line: number;
  status: ThreadStatus;
  severity: Severity | null;
  anchor_content: string | null;
  send_id: string | null;
  delivery: DeliveryState | null;
  created_at: number;
  updated_at: number;
  bb_thread_id: string | null;
  sent_at: number | null;
}

export interface NewRun {
  /** Chosen by the caller when the run's thread must carry it before the row exists. */
  id?: string;
  sessionId: string;
  kind: RunKind;
  bbThreadId: string | null;
  reviewThreadId: string | null;
  focus: string | null;
  providerId: string;
  model: string | null;
  status: RunStatus;
  summary?: string | null;
  baseline?: string | null;
  /** The thread under review the run's thread is a child of. */
  parentThreadId?: string | null;
}

interface RunRow {
  id: string;
  session_id: string;
  kind: RunKind;
  bb_thread_id: string | null;
  review_thread_id: string | null;
  focus: string | null;
  provider_id: string;
  model: string | null;
  status: RunStatus;
  summary: string | null;
  baseline: string | null;
  changed_files: string | null;
  created_at: number;
  finished_at: number | null;
  parent_thread_id: string | null;
}

/** A run as stored, with the baseline only the server reads. */
export type StoredRun = Run & { baseline: string | null };

interface CommentRow {
  id: string;
  thread_id: string;
  author_type: AuthorType;
  author_name: string;
  body: string;
  created_at: number;
  edited_at: number | null;
}

/** Twelve hex characters: short enough for an agent to type, and found by any unique prefix. */
export function newId(): string {
  return randomBytes(6).toString("hex");
}

const THREAD_SELECT = `
  SELECT t.*, s.bb_thread_id AS bb_thread_id, s.created_at AS sent_at
  FROM review_threads t LEFT JOIN sends s ON s.id = t.send_id`;

export class ReviewStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    db.pragma("foreign_keys = ON");
  }

  /** The session for a workspace and view, made the first time it is asked for. */
  session(environmentId: string, targetKey: string): Session {
    const found = this.db
      .prepare<[string, string], { id: string }>("SELECT id FROM review_sessions WHERE environment_id = ? AND target_key = ?")
      .get(environmentId, targetKey);
    if (found !== undefined) return { id: found.id, environmentId, targetKey };
    const id = newId();
    this.db
      .prepare("INSERT INTO review_sessions (id, environment_id, target_key, created_at) VALUES (?, ?, ?, ?)")
      .run(id, environmentId, targetKey, this.now());
    return { id, environmentId, targetKey };
  }

  sessionById(id: string): Session | null {
    const row = this.db
      .prepare<[string], { id: string; environment_id: string; target_key: string }>("SELECT * FROM review_sessions WHERE id = ?")
      .get(id);
    return row === undefined ? null : { id: row.id, environmentId: row.environment_id, targetKey: row.target_key };
  }

  /** Every thread of a session with its comments, oldest first. */
  threads(sessionId: string): ReviewThread[] {
    const rows = this.db.prepare<[string], ThreadRow>(`${THREAD_SELECT} WHERE t.session_id = ? ORDER BY t.created_at, t.rowid`).all(sessionId);
    return this.withComments(rows);
  }

  thread(id: string): ReviewThread | null {
    const row = this.db.prepare<[string], ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?`).get(id);
    return row === undefined ? null : this.withComments([row])[0]!;
  }

  /** The threads whose last send went to `bbThreadId`, oldest first. */
  threadsSentTo(bbThreadId: string): ReviewThread[] {
    const rows = this.db.prepare<[string], ThreadRow>(`${THREAD_SELECT} WHERE s.bb_thread_id = ? ORDER BY t.created_at, t.rowid`).all(bbThreadId);
    return this.withComments(rows);
  }

  /** Makes a thread with its first comment, the user's unless `author` says otherwise. */
  createThread(input: NewThread, author: { type: AuthorType; name: string } = { type: "user", name: "You" }): ReviewThread {
    const id = newId();
    const at = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_threads (id, session_id, file_path, side, start_line, end_line, severity, anchor_content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.sessionId, input.filePath, input.side, input.startLine, input.endLine, input.severity, input.anchorContent, at, at);
      this.insertComment({ threadId: id, authorType: author.type, authorName: author.name, body: input.body }, at);
    })();
    return this.thread(id)!;
  }

  /** Adds a comment. An agent's comment answers the thread's send. */
  addComment(input: NewComment): ReviewComment {
    const at = this.now();
    const id = this.db.transaction(() => {
      const commentId = this.insertComment(input, at);
      this.touch(input.threadId, at, input.authorType === "agent");
      return commentId;
    })();
    return this.comment(id)!;
  }

  comment(id: string): (ReviewComment & { threadId: string }) | null {
    const row = this.db.prepare<[string], CommentRow>("SELECT * FROM review_comments WHERE id = ?").get(id);
    return row === undefined ? null : { ...toComment(row), threadId: row.thread_id };
  }

  editComment(id: string, body: string): void {
    const at = this.now();
    const row = this.comment(id);
    if (row === null) return;
    this.db.transaction(() => {
      this.db.prepare("UPDATE review_comments SET body = ?, edited_at = ? WHERE id = ?").run(body, at, id);
      this.touch(row.threadId, at, false);
    })();
  }

  /** Deletes a comment, and its thread when it was the thread's last one. */
  deleteComment(id: string): void {
    const row = this.comment(id);
    if (row === null) return;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM review_comments WHERE id = ?").run(id);
      const left = this.db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM review_comments WHERE thread_id = ?").get(row.threadId)!.n;
      if (left === 0) this.db.prepare("DELETE FROM review_threads WHERE id = ?").run(row.threadId);
      else this.touch(row.threadId, this.now(), false);
    })();
  }

  /** Sets a thread's status; `answered` marks the change as the agent's answer to its send. */
  setStatus(id: string, status: ThreadStatus, answered: boolean): void {
    const at = this.now();
    this.db.prepare("UPDATE review_threads SET status = ?, updated_at = ? WHERE id = ?").run(status, at, id);
    if (answered) this.touch(id, at, true);
  }

  /** Records a send and points each thread at it. */
  recordSend(sessionId: string, bbThreadId: string, threadIds: readonly string[], note: string): { id: string; createdAt: number } {
    const id = newId();
    const createdAt = this.now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO sends (id, session_id, bb_thread_id, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, bbThreadId, note, createdAt);
      const point = this.db.prepare("UPDATE review_threads SET send_id = ?, delivery = 'sent', updated_at = ? WHERE id = ? AND session_id = ?");
      for (const threadId of threadIds) point.run(id, createdAt, threadId, sessionId);
    })();
    return { id, createdAt };
  }

  /** Undoes `recordSend` when the message could not be delivered. */
  dropSend(sendId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE review_threads SET send_id = NULL, delivery = NULL WHERE send_id = ?").run(sendId);
      this.db.prepare("DELETE FROM sends WHERE id = ?").run(sendId);
    })();
  }

  /** The threads sent to `bbThreadId` still waiting for an answer, with when they were sent. */
  waitingOn(bbThreadId: string): { threadId: string; sessionId: string; sentAt: number }[] {
    return this.db
      .prepare<[string], { id: string; session_id: string; sent_at: number }>(
        `SELECT t.id, t.session_id, s.created_at AS sent_at FROM review_threads t JOIN sends s ON s.id = t.send_id
         WHERE s.bb_thread_id = ? AND t.delivery = 'sent'`,
      )
      .all(bbThreadId)
      .map((row) => ({ threadId: row.id, sessionId: row.session_id, sentAt: row.sent_at }));
  }

  markNoReply(threadIds: readonly string[]): void {
    const mark = this.db.prepare("UPDATE review_threads SET delivery = 'no_reply' WHERE id = ? AND delivery = 'sent'");
    this.db.transaction(() => {
      for (const id of threadIds) mark.run(id);
    })();
  }

  /** The sessions of a workspace. */
  sessionsOf(environmentId: string): Session[] {
    return this.db
      .prepare<[string], { id: string; target_key: string }>("SELECT id, target_key FROM review_sessions WHERE environment_id = ?")
      .all(environmentId)
      .map((row) => ({ id: row.id, environmentId, targetKey: row.target_key }));
  }

  createRun(input: NewRun): StoredRun {
    const id = input.id ?? newId();
    const at = this.now();
    const finished = input.status === "running" ? null : at;
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, bb_thread_id, review_thread_id, focus, provider_id, model, status, summary, baseline, created_at, finished_at, parent_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, input.kind, input.bbThreadId, input.reviewThreadId, input.focus, input.providerId, input.model, input.status, input.summary ?? null, input.baseline ?? null, at, finished, input.parentThreadId ?? null);
    return this.run(id)!;
  }

  run(id: string): StoredRun | null {
    const row = this.db.prepare<[string], RunRow>("SELECT * FROM runs WHERE id = ?").get(id);
    return row === undefined ? null : toRun(row);
  }

  /** The runs of a session not yet closed, newest first. */
  openRuns(sessionId: string): StoredRun[] {
    return this.db
      .prepare<[string], RunRow>("SELECT * FROM runs WHERE session_id = ? AND status != 'closed' ORDER BY created_at DESC, rowid DESC")
      .all(sessionId)
      .map(toRun);
  }

  /** The runs a bb thread carries that are not closed, newest first. */
  runsOfThread(bbThreadId: string): StoredRun[] {
    return this.db
      .prepare<[string], RunRow>("SELECT * FROM runs WHERE bb_thread_id = ? AND status != 'closed' ORDER BY created_at DESC, rowid DESC")
      .all(bbThreadId)
      .map(toRun);
  }

  /** Whether a thread has run threads as children (closed ones included: bb may still be reporting them). */
  hasRunChildren(threadId: string): boolean {
    return this.db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM runs WHERE parent_thread_id = ?").get(threadId)!.n > 0;
  }

  /** The open mention run answering a comment thread with a provider, if any. */
  mentionRun(reviewThreadId: string, providerId: string): StoredRun | null {
    const row = this.db
      .prepare<[string, string], RunRow>(
        "SELECT * FROM runs WHERE kind = 'mention' AND review_thread_id = ? AND provider_id = ? AND status != 'closed' AND bb_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(reviewThreadId, providerId);
    return row === undefined ? null : toRun(row);
  }

  /** Records the thread a run was started in. */
  setRunThread(id: string, bbThreadId: string): void {
    this.db.prepare("UPDATE runs SET bb_thread_id = ? WHERE id = ?").run(bbThreadId, id);
  }

  /** Marks a run running again (a follow-up was sent to its thread). */
  restartRun(id: string): void {
    this.db.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ? AND status != 'closed'").run(id);
  }

  finishRun(id: string, status: "done" | "failed", summary: string | null, changedFiles: readonly string[] | null): void {
    this.db
      .prepare("UPDATE runs SET status = ?, summary = ?, changed_files = ?, finished_at = ? WHERE id = ? AND status != 'closed'")
      .run(status, summary, changedFiles === null ? null : JSON.stringify(changedFiles), this.now(), id);
  }

  closeRun(id: string): void {
    this.db.prepare("UPDATE runs SET status = 'closed' WHERE id = ?").run(id);
  }

  private insertComment(input: NewComment, at: number): string {
    const id = newId();
    this.db
      .prepare("INSERT INTO review_comments (id, thread_id, author_type, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.threadId, input.authorType, input.authorName, input.body, at);
    return id;
  }

  private touch(threadId: string, at: number, answered: boolean): void {
    this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(at, threadId);
    if (answered) this.db.prepare("UPDATE review_threads SET delivery = 'answered' WHERE id = ? AND send_id IS NOT NULL").run(threadId);
  }

  private withComments(rows: ThreadRow[]): ReviewThread[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const comments = this.db
      .prepare<string[], CommentRow>(`SELECT * FROM review_comments WHERE thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
      .all(...ids);
    const byThread = new Map<string, ReviewComment[]>();
    for (const row of comments) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(toComment(row));
      byThread.set(row.thread_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      side: row.side,
      startLine: row.start_line,
      endLine: row.end_line,
      status: row.status,
      severity: row.severity,
      anchorContent: row.anchor_content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      comments: byThread.get(row.id) ?? [],
      delivery:
        row.send_id === null || row.delivery === null || row.bb_thread_id === null || row.sent_at === null
          ? null
          : { state: row.delivery, sendId: row.send_id, threadId: row.bb_thread_id, sentAt: row.sent_at },
    }));
  }
}

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    threadId: row.bb_thread_id,
    reviewThreadId: row.review_thread_id,
    focus: row.focus,
    providerId: row.provider_id,
    model: row.model,
    status: row.status,
    summary: row.summary,
    changedFiles: row.changed_files === null ? null : (JSON.parse(row.changed_files) as string[]),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    baseline: row.baseline,
  };
}

function toComment(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    authorType: row.author_type,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}
