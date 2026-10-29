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
  // What each thread's Review tab keeps of a view: drafts, folds, scroll.
  `CREATE TABLE view_states (
     thread_id TEXT NOT NULL,
     session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (thread_id, session_id)
   )`,
  // What each send replaced, per comment thread, so a failed send can be rolled back whatever order
  // overlapping sends settle in.
  `CREATE TABLE send_previous (
     send_id TEXT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
     thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
     previous_send_id TEXT,
     previous_delivery TEXT,
     PRIMARY KEY (send_id, thread_id)
   )`,
  // The revision of the file a thread was made on, as bb's Git plugin gave it, to tell that the file
  // changed since.
  `ALTER TABLE review_threads ADD COLUMN file_revision TEXT`,
  // Summaries and explanations are review-kind runs (they read and comment, never edit) with a
  // purpose; the table's kind check predates them and SQLite cannot widen it in place.
  `ALTER TABLE runs ADD COLUMN purpose TEXT`,
];

export interface Session {
  id: string;
  environmentId: string;
  targetKey: string;
}

export interface ReviewSummaryRow {
  sessionId: string;
  environmentId: string;
  targetKey: string;
  openCount: number;
  totalCount: number;
  updatedAt: number;
  viewerThreadId: string | null;
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
  /** The file's revision in the diff the thread was made on; null for a whole-diff thread or when not known. */
  fileRevision?: string | null;
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
  file_revision: string | null;
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
  purpose: "summary" | "explain" | null;
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

export interface RecordedSend {
  id: string;
  createdAt: number;
}

/** Where a run's sends point before bb has given it a thread (`bindRun` moves them). */
export function pendingRunThread(runId: string): string {
  return `run:${runId}`;
}

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
          `INSERT INTO review_threads (id, session_id, file_path, side, start_line, end_line, severity, anchor_content, file_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.sessionId, input.filePath, input.side, input.startLine, input.endLine, input.severity, input.anchorContent, input.fileRevision ?? null, at, at);
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

  /**
   * Records a send and points each thread at it, keeping what each thread pointed at before
   * (`send_previous`) so `dropSend` can put it back if this send cannot be delivered.
   */
  recordSend(sessionId: string, bbThreadId: string, threadIds: readonly string[], note: string): RecordedSend {
    const id = newId();
    const createdAt = this.now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO sends (id, session_id, bb_thread_id, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, bbThreadId, note, createdAt);
      const read = this.db.prepare<[string, string], { send_id: string | null; delivery: DeliveryState | null }>(
        "SELECT send_id, delivery FROM review_threads WHERE id = ? AND session_id = ?",
      );
      const keep = this.db.prepare("INSERT INTO send_previous (send_id, thread_id, previous_send_id, previous_delivery) VALUES (?, ?, ?, ?)");
      const point = this.db.prepare("UPDATE review_threads SET send_id = ?, delivery = 'sent', updated_at = ? WHERE id = ? AND session_id = ?");
      for (const threadId of new Set(threadIds)) {
        const row = read.get(threadId, sessionId);
        if (row === undefined) continue;
        keep.run(id, threadId, row.send_id, row.delivery);
        point.run(id, createdAt, threadId, sessionId);
      }
    })();
    return { id, createdAt };
  }

  /**
   * Undoes `recordSend` when the message could not be delivered (or its run was cancelled before it
   * was). For each of its threads: if the thread still points at it, the thread goes back to what it
   * pointed at before (an earlier delivery keeps its answer rights); if a later send owns the thread,
   * that send's own "before" skips over this one, so whichever of overlapping sends fails last still
   * restores a send that exists. A later send that succeeded keeps the thread. A send already gone
   * (Clear review deleted it) is a no-op.
   */
  dropSend(send: Pick<RecordedSend, "id">): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare<[string], { thread_id: string; previous_send_id: string | null; previous_delivery: DeliveryState | null }>(
          "SELECT thread_id, previous_send_id, previous_delivery FROM send_previous WHERE send_id = ?",
        )
        .all(send.id);
      const restore = this.db.prepare("UPDATE review_threads SET send_id = ?, delivery = ? WHERE id = ? AND send_id = ?");
      const skip = this.db.prepare("UPDATE send_previous SET previous_send_id = ?, previous_delivery = ? WHERE thread_id = ? AND previous_send_id = ?");
      for (const row of rows) {
        if (restore.run(row.previous_send_id, row.previous_delivery, row.thread_id, send.id).changes === 0) {
          skip.run(row.previous_send_id, row.previous_delivery, row.thread_id, send.id);
        }
      }
      this.db.prepare("UPDATE review_threads SET send_id = NULL, delivery = NULL WHERE send_id = ?").run(send.id);
      this.db.prepare("UPDATE send_previous SET previous_send_id = NULL, previous_delivery = NULL WHERE previous_send_id = ?").run(send.id);
      this.db.prepare("DELETE FROM sends WHERE id = ?").run(send.id);
    })();
  }

  /**
   * An agent's answer in a thread, in one transaction: its comment, the new status if any, and, when
   * the thread's current send went to that agent and was there when its turn started (`ackBefore`, or
   * any time when unknown), that send marked answered. An answer from an earlier turn does not
   * acknowledge a question queued after it, nor a send to another thread.
   */
  answerAsAgent(input: { threadId: string; callerThreadId: string; ackBefore: number | null; authorName: string; body: string; status: ThreadStatus | null }): void {
    const at = this.now();
    this.db.transaction(() => {
      this.insertComment({ threadId: input.threadId, authorType: "agent", authorName: input.authorName, body: input.body }, at);
      if (input.status !== null) this.db.prepare("UPDATE review_threads SET status = ? WHERE id = ?").run(input.status, input.threadId);
      this.db.prepare("UPDATE review_threads SET updated_at = ? WHERE id = ?").run(at, input.threadId);
      this.db
        .prepare(
          `UPDATE review_threads SET delivery = 'answered' WHERE id = ? AND send_id IN
             (SELECT id FROM sends WHERE bb_thread_id = ? AND (? IS NULL OR created_at <= ?))`,
        )
        .run(input.threadId, input.callerThreadId, input.ackBefore, input.ackBefore);
    })();
  }

  /** The threads sent to `bbThreadId` still waiting for an answer, with when they were sent. */
  waitingOn(bbThreadId: string): { threadId: string; sessionId: string; sendId: string; sentAt: number }[] {
    return this.db
      .prepare<[string], { id: string; session_id: string; send_id: string; sent_at: number }>(
        `SELECT t.id, t.session_id, t.send_id, s.created_at AS sent_at FROM review_threads t JOIN sends s ON s.id = t.send_id
         WHERE s.bb_thread_id = ? AND t.delivery = 'sent'`,
      )
      .all(bbThreadId)
      .map((row) => ({ threadId: row.id, sessionId: row.session_id, sendId: row.send_id, sentAt: row.sent_at }));
  }

  /**
   * Marks sends "no reply", each only while its thread still points at that very send and waits: a
   * thread sent on since keeps its newer send. Returns the rows it changed.
   */
  markNoReply<Row extends { threadId: string; sendId: string }>(rows: readonly Row[]): Row[] {
    const mark = this.db.prepare("UPDATE review_threads SET delivery = 'no_reply' WHERE id = ? AND send_id = ? AND delivery = 'sent'");
    return this.db.transaction(() => rows.filter((row) => mark.run(row.threadId, row.sendId).changes > 0))();
  }

  /** The sessions of a workspace. */
  /**
   * Every session with comment threads (or only `sessionId`), newest activity first (at most `limit`,
   * all by default): its
   * counts, and the bb thread whose Review tab opened it last (null when no tab kept state for it, as
   * for a review only an agent wrote).
   */
  reviewSummaries(limit = -1, sessionId: string | null = null): ReviewSummaryRow[] {
    return this.db
      .prepare<[string | null, string | null, number], ReviewSummaryRow>(
        `SELECT s.id AS sessionId, s.environment_id AS environmentId, s.target_key AS targetKey,
                SUM(CASE WHEN t.status = 'open' THEN 1 ELSE 0 END) AS openCount,
                COUNT(t.id) AS totalCount,
                MAX(t.updated_at) AS updatedAt,
                (SELECT v.thread_id FROM view_states v WHERE v.session_id = s.id ORDER BY v.updated_at DESC LIMIT 1) AS viewerThreadId
         FROM review_sessions s JOIN review_threads t ON t.session_id = s.id
         WHERE ? IS NULL OR s.id = ?
         GROUP BY s.id
         ORDER BY updatedAt DESC
         LIMIT ?`,
      )
      .all(sessionId, sessionId, limit);
  }

  /** Open and all comment threads, in one workspace's sessions or in all of them. */
  threadCounts(environmentId: string | null): { open: number; total: number } {
    const row = this.db
      .prepare<[string | null, string | null], { open: number | null; total: number }>(
        `SELECT SUM(CASE WHEN t.status = 'open' THEN 1 ELSE 0 END) AS open, COUNT(t.id) AS total
         FROM review_threads t JOIN review_sessions s ON s.id = t.session_id
         WHERE ? IS NULL OR s.environment_id = ?`,
      )
      .get(environmentId, environmentId)!;
    return { open: row.open ?? 0, total: row.total };
  }

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
    const purpose = input.kind === "summary" || input.kind === "explain" ? input.kind : null;
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, kind, purpose, bb_thread_id, review_thread_id, focus, provider_id, model, status, summary, baseline, created_at, finished_at, parent_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, purpose === null ? input.kind : "review", purpose, input.bbThreadId, input.reviewThreadId, input.focus, input.providerId, input.model, input.status, input.summary ?? null, input.baseline ?? null, at, finished, input.parentThreadId ?? null);
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

  /** A view's reviewer: its latest review run that has a thread and is not closed, if any. */
  reviewerRun(sessionId: string): StoredRun | null {
    const row = this.db
      .prepare<[string], RunRow>(
        "SELECT * FROM runs WHERE session_id = ? AND kind = 'review' AND purpose IS NULL AND status != 'closed' AND bb_thread_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId);
    return row === undefined ? null : toRun(row);
  }

  /**
   * Binds a run to the thread bb started for it, once: its row and the sends recorded for it while it
   * had no thread now name that thread. Returns false when the run is unknown or already bound.
   */
  bindRun(id: string, bbThreadId: string): boolean {
    return this.db.transaction(() => {
      const bound = this.db.prepare("UPDATE runs SET bb_thread_id = ? WHERE id = ? AND bb_thread_id IS NULL").run(bbThreadId, id).changes > 0;
      if (bound) this.db.prepare("UPDATE sends SET bb_thread_id = ? WHERE bb_thread_id = ?").run(bbThreadId, pendingRunThread(id));
      return bound;
    })();
  }

  /** Whether some run not yet closed is still waiting for bb to give it a thread. */
  hasUnboundRuns(): boolean {
    return this.db.prepare("SELECT 1 FROM runs WHERE bb_thread_id IS NULL AND status != 'closed' LIMIT 1").get() !== undefined;
  }

  /**
   * Whether `bbThreadId` is the thread of AI runs that are all closed: it has lost every right, those
   * from sends to it included. A thread that never was a run's (the one under review) is not.
   */
  isClosedRunThread(bbThreadId: string): boolean {
    const row = this.db
      .prepare<[string], { runs: number; open: number }>("SELECT count(*) AS runs, sum(status != 'closed') AS open FROM runs WHERE bb_thread_id = ?")
      .get(bbThreadId)!;
    return row.runs > 0 && (row.open ?? 0) === 0;
  }

  /** What a run's start learned after its row was written: its parent, baseline, provider and model. */
  prepareRun(id: string, input: { parentThreadId: string | null; baseline: string | null; providerId: string; model: string | null }): void {
    this.db
      .prepare("UPDATE runs SET parent_thread_id = ?, baseline = ?, provider_id = ?, model = ? WHERE id = ?")
      .run(input.parentThreadId, input.baseline, input.providerId, input.model, id);
  }

  /** Whether `bbThreadId` is any run's thread, closed ones included. */
  isRunThread(bbThreadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM runs WHERE bb_thread_id = ? LIMIT 1").get(bbThreadId) !== undefined;
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

  /** What `threadId`'s tab kept of a session's view, as it saved it; null when nothing was kept. */
  viewState(threadId: string, sessionId: string): unknown {
    const row = this.db
      .prepare<[string, string], { state: string }>("SELECT state FROM view_states WHERE thread_id = ? AND session_id = ?")
      .get(threadId, sessionId);
    return row === undefined ? null : (JSON.parse(row.state) as unknown);
  }

  /**
   * Keeps a tab's state unless a copy saved later (by `savedAt`) is already there: two windows can
   * flush in the reverse order of their edits. Returns whether it was kept.
   */
  saveViewState(threadId: string, sessionId: string, state: { savedAt: number }): boolean {
    return this.db.transaction(() => {
      const current = this.viewState(threadId, sessionId) as { savedAt?: unknown } | null;
      if (current !== null && typeof current.savedAt === "number" && current.savedAt > state.savedAt) return false;
      this.db
        .prepare(
          `INSERT INTO view_states (thread_id, session_id, state, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (thread_id, session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        )
        .run(threadId, sessionId, JSON.stringify(state), this.now());
      return true;
    })();
  }

  /**
   * Clears a session's review: deletes its threads (their comments go with them) and sends, and closes
   * its runs. Closed runs stay as rows, so `hasRunChildren` still knows their parents. Returns the runs
   * that were still open, whose threads the caller archives.
   */
  clearSession(sessionId: string): StoredRun[] {
    return this.db.transaction(() => {
      const open = this.openRuns(sessionId);
      // Threads first: they point at sends.
      this.db.prepare("DELETE FROM review_threads WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sends WHERE session_id = ?").run(sessionId);
      this.db.prepare("UPDATE runs SET status = 'closed' WHERE session_id = ?").run(sessionId);
      return open;
    })();
  }

  /**
   * Deletes a session and everything of it: threads and their comments, sends, runs and each tab's
   * kept state. Returns the runs that were still open, whose threads the caller archives.
   */
  deleteSession(sessionId: string): StoredRun[] {
    return this.db.transaction(() => {
      const open = this.openRuns(sessionId);
      // Threads first: they point at sends, which the session's delete takes with it.
      this.db.prepare("DELETE FROM review_threads WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM review_sessions WHERE id = ?").run(sessionId);
      return open;
    })();
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
      fileRevision: row.file_revision,
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
    kind: row.purpose ?? row.kind,
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
