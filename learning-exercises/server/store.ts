/**
 * The plugin's own SQLite (`bb.storage.database()`): offers, sessions, the questions each session
 * asked with the learner's answers, per-thread offer state and a few global values. Learners' answers
 * can outgrow kv's 256 KB, and they stay on this machine; the tab deletes them per session.
 *
 * `MIGRATIONS` is append-only: bb records each statement's index as applied, so a shipped statement is
 * never edited or reordered, only followed by new ones.
 */
import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { FormValuesSchema, readAnswerForm, type AnswerForm, type FormValues } from "../shared/answer-form";
import {
  RefsSchema,
  type Exercise,
  type ExerciseType,
  type Offer,
  type OfferAnswer,
  CardDraftSchema,
  REPLY_MAX_CHARS,
  type CardDraft,
  type Refs,
  type Session,
  type SessionMode,
  type SessionState,
  type TriggerKind,
  type Verdict,
} from "../shared/types";
import type { GlobalState } from "./policy";

export const MIGRATIONS: string[] = [
  `CREATE TABLE offers (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     project_key TEXT NOT NULL,
     trigger TEXT NOT NULL,
     topic TEXT NOT NULL,
     refs TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('live', 'answered', 'expired', 'superseded')),
     answer TEXT,
     created_at INTEGER NOT NULL,
     seen_at INTEGER,
     answered_at INTEGER
   )`,
  `CREATE INDEX offers_thread ON offers(thread_id, status)`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'exercise',
     mode TEXT NOT NULL CHECK (mode IN ('fork', 'here')),
     state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'awaiting-answer', 'paused', 'finished', 'abandoned')),
     project_key TEXT NOT NULL,
     project_id TEXT NOT NULL,
     source_thread_id TEXT,
     thread_id TEXT,
     topic TEXT NOT NULL,
     trigger TEXT NOT NULL,
     refs TEXT NOT NULL,
     offer_id TEXT,
     pause_reason TEXT,
     summary TEXT,
     concepts TEXT NOT NULL DEFAULT '[]',
     brief_version TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE INDEX sessions_thread ON sessions(thread_id)`,
  `CREATE INDEX sessions_source ON sessions(source_thread_id)`,
  `CREATE INDEX sessions_project ON sessions(project_key, state)`,
  `CREATE TABLE exercises (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     type TEXT NOT NULL,
     question TEXT NOT NULL,
     files TEXT NOT NULL,
     asked_at INTEGER NOT NULL,
     answer TEXT,
     confidence INTEGER,
     skipped INTEGER NOT NULL DEFAULT 0,
     stuck INTEGER NOT NULL DEFAULT 0,
     answered_at INTEGER,
     verdict TEXT,
     gap TEXT,
     PRIMARY KEY (session_id, ordinal)
   )`,
  `CREATE TABLE thread_state (
     thread_id TEXT PRIMARY KEY,
     opt_out INTEGER NOT NULL DEFAULT 0,
     snooze_until INTEGER,
     snooze_until_turn INTEGER,
     completed_turns INTEGER NOT NULL DEFAULT 0,
     changed_turns_since_offer INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE global_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // At most one open session per source thread, whatever races to create a second.
  `CREATE UNIQUE INDEX sessions_one_open_per_source ON sessions(source_thread_id)
     WHERE source_thread_id IS NOT NULL AND state IN ('starting', 'active', 'awaiting-answer', 'paused')`,
  // The last commits a turn of the thread made, for the tab's topic picker on a default branch.
  `ALTER TABLE thread_state ADD COLUMN last_commits TEXT`,
  // The answer form a question was asked with, and the learner's answer to it by field id (JSON).
  `ALTER TABLE exercises ADD COLUMN form TEXT`,
  `ALTER TABLE exercises ADD COLUMN fields TEXT`,
  // What the agent wrote after the answer and before the next question (its feedback), from the event log.
  `ALTER TABLE exercises ADD COLUMN reply TEXT`,
  // How far an unfinished read of that reply got in the log (JSON: the seq to go on below, the texts so far).
  `ALTER TABLE exercises ADD COLUMN reply_progress TEXT`,
  // The learner's unsent answer to an open question (JSON `CardDraft`), until they answer or skip it.
  `ALTER TABLE exercises ADD COLUMN draft TEXT`,
  // When that draft was stored, rising per question: the token a card's backup is checked against.
  `ALTER TABLE exercises ADD COLUMN draft_saved_at INTEGER`,
  // Which browser saved that draft last (the app's writer id), so a card tells its own saves from others'.
  `ALTER TABLE exercises ADD COLUMN draft_writer TEXT`,
  // The feedback the agent passed with its verdict (Markdown), which the chat and the next card show.
  `ALTER TABLE exercises ADD COLUMN feedback TEXT`,
  // The bb turn that verdict was recorded in: the chat's feedback card sits above that turn's last message.
  `ALTER TABLE exercises ADD COLUMN feedback_turn TEXT`,
  // 0.2.0: the caps count answered offers, under their own key. Seeded once, here, from the answers
  // 0.1.0 recorded on its offers (offers only seen are left out), so an upgrade keeps today's cap and gap.
  `INSERT OR IGNORE INTO global_state (key, value)
     SELECT 'answeredAt', json_group_array(answered_at)
     FROM (SELECT answered_at FROM offers WHERE status = 'answered' AND answered_at IS NOT NULL ORDER BY answered_at DESC LIMIT 50)`,
  // 0.3.0: repo orientations (spec §4). `next_ordinal` and `next_listing` only rise, so a popped block
  // frees neither its ordinal nor its listing number.
  `CREATE TABLE orientations (
     id TEXT PRIMARY KEY,
     project_key TEXT NOT NULL,
     project_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('starting', 'building', 'ready', 'failed', 'cancelled')),
     depth TEXT NOT NULL CHECK (depth IN ('summary', 'walkthrough')),
     source_thread_id TEXT NOT NULL,
     environment_id TEXT,
     host_id TEXT,
     workspace_path TEXT,
     provider_id TEXT NOT NULL,
     builder_thread_id TEXT,
     head_sha TEXT,
     title TEXT NOT NULL,
     summary TEXT,
     reminded INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     next_ordinal INTEGER NOT NULL DEFAULT 1,
     next_listing INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     ready_at INTEGER
   )`,
  `CREATE TABLE orientation_blocks (
     orientation_id TEXT NOT NULL REFERENCES orientations(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('chapter', 'note', 'listing')),
     text TEXT,
     listing_no INTEGER,
     caption TEXT,
     path TEXT,
     start_line INTEGER,
     end_line INTEGER,
     captured TEXT,
     captured_sha256 TEXT,
     captured_ref TEXT,
     check_state TEXT,
     check_start INTEGER,
     check_end INTEGER,
     checked_at INTEGER,
     PRIMARY KEY (orientation_id, ordinal)
   )`,
  // One orientation being built per project, whatever races to start a second.
  `CREATE UNIQUE INDEX orientations_one_live_per_project ON orientations(project_key)
     WHERE status IN ('starting', 'building')`,
  `CREATE INDEX orientations_builder ON orientations(builder_thread_id)`,
  // 0.3.0: orientation sessions run in a thread of their own, mode 'spawn'. SQLite cannot loosen a CHECK in
  // place, so `sessions` is rebuilt. Dropping it cascades away `exercises`, so both tables' rows are kept
  // aside first (a table made by SELECT * keeps the column order) and put back after.
  `CREATE TABLE sessions_keep AS SELECT * FROM sessions`,
  `CREATE TABLE exercises_keep AS SELECT * FROM exercises`,
  // With foreign keys off the drop would not cascade, and the restore would hit the primary key.
  `DELETE FROM exercises`,
  `DROP TABLE sessions`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'exercise',
     mode TEXT NOT NULL CHECK (mode IN ('fork', 'here', 'spawn')),
     state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'awaiting-answer', 'paused', 'finished', 'abandoned')),
     project_key TEXT NOT NULL,
     project_id TEXT NOT NULL,
     source_thread_id TEXT,
     thread_id TEXT,
     topic TEXT NOT NULL,
     trigger TEXT NOT NULL,
     refs TEXT NOT NULL,
     offer_id TEXT,
     pause_reason TEXT,
     summary TEXT,
     concepts TEXT NOT NULL DEFAULT '[]',
     brief_version TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE INDEX sessions_thread ON sessions(thread_id)`,
  `CREATE INDEX sessions_source ON sessions(source_thread_id)`,
  `CREATE INDEX sessions_project ON sessions(project_key, state)`,
  `CREATE UNIQUE INDEX sessions_one_open_per_source ON sessions(source_thread_id)
     WHERE source_thread_id IS NOT NULL AND state IN ('starting', 'active', 'awaiting-answer', 'paused')`,
  `INSERT INTO sessions SELECT * FROM sessions_keep`,
  `INSERT INTO exercises SELECT * FROM exercises_keep`,
  `DROP TABLE sessions_keep`,
  `DROP TABLE exercises_keep`,
];

const ReplyProgressSchema = z.object({
  before: z.string().regex(/^\d{1,20}$/),
  text: z.string().max(REPLY_MAX_CHARS),
  truncated: z.boolean(),
});
/**
 * An unfinished read of a reply: rows at or above `before` were read, and `text` is what they held, joined
 * oldest first and cut to the `REPLY_MAX_CHARS` the final reply can use (`truncated` when something was
 * cut). A value of another shape or size reads as none, and the read starts again from the newest event.
 */
export type ReplyProgress = z.infer<typeof ReplyProgressSchema>;

/** The partial unique index migration 9 creates (one open session per source thread). */
const ONE_OPEN_INDEX = "sessions_one_open_per_source";

/**
 * Runs before `bb.storage.migrate`. Versions before the unique index (0.1.0's first draft, e54db75)
 * could leave two open sessions for one source thread (a Start race), and creating the index over them
 * fails the plugin's load. So, once, before the index exists: per source thread, keep the most
 * progressed open session (waiting for an answer, then running, then paused, then starting; then the
 * one with the most answers; then the newest) and mark the others abandoned. Nothing is deleted: their
 * questions and answers stay in the history. A store without the sessions table yet, or with the index
 * already, is left alone. Kept out of `MIGRATIONS` so migration 9 stays the index statement an earlier
 * build already recorded.
 */
export function reconcileOpenSessions(db: Database.Database, now: number): number {
  const has = (type: string, name: string) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) !== undefined;
  if (!has("table", "sessions") || has("index", ONE_OPEN_INDEX)) return 0;
  return db
    .prepare(
      `UPDATE sessions SET state = 'abandoned', pause_reason = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE id IN (
         SELECT id FROM (
           SELECT s.id, ROW_NUMBER() OVER (
             PARTITION BY s.source_thread_id
             ORDER BY CASE s.state WHEN 'awaiting-answer' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                      (SELECT COUNT(*) FROM exercises e WHERE e.session_id = s.id AND e.answer IS NOT NULL) DESC,
                      s.updated_at DESC, s.created_at DESC, s.id DESC
           ) AS rank
           FROM sessions s
           WHERE s.source_thread_id IS NOT NULL AND s.state IN ('starting', 'active', 'awaiting-answer', 'paused')
         ) WHERE rank > 1
       )`,
    )
    .run(now, now).changes;
}

/** Sessions that still count as open: not finished, not abandoned. */
export const OPEN_STATES: readonly SessionState[] = ["starting", "active", "awaiting-answer", "paused"];

export interface SessionRow extends Session {
  projectKey: string;
  projectId: string;
  refs: Refs;
  offerId: string | null;
  concepts: string[];
}

export interface ThreadRow {
  threadId: string;
  optOut: boolean;
  snoozeUntil: number | null;
  snoozeUntilTurn: number | null;
  completedTurns: number;
  changedTurnsSinceOffer: number;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function parseRefs(raw: string): Refs {
  try {
    const parsed = RefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function parseStrings(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

interface OfferRecord {
  id: string;
  thread_id: string;
  project_key: string;
  trigger: string;
  topic: string;
  refs: string;
  status: string;
  answer: string | null;
  created_at: number;
  seen_at: number | null;
  answered_at: number | null;
}

interface SessionRecord {
  id: string;
  mode: SessionMode;
  state: SessionState;
  project_key: string;
  project_id: string;
  source_thread_id: string | null;
  thread_id: string | null;
  topic: string;
  trigger: TriggerKind;
  refs: string;
  offer_id: string | null;
  pause_reason: string | null;
  summary: string | null;
  concepts: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  asked: number;
  answered: number;
}

interface ExerciseRecord {
  ordinal: number;
  type: ExerciseType;
  question: string;
  files: string;
  asked_at: number;
  answer: string | null;
  confidence: number | null;
  skipped: number;
  stuck: number;
  answered_at: number | null;
  verdict: Verdict | null;
  gap: string | null;
  form: string | null;
  fields: string | null;
  reply: string | null;
  feedback: string | null;
  feedback_turn: string | null;
}

/** Stored JSON read back through its schema; null when it is missing or no longer reads. */
function parseJson<T>(text: string | null, read: (value: unknown) => T | null): T | null {
  if (text === null) return null;
  try {
    return read(JSON.parse(text));
  } catch {
    return null;
  }
}

const SESSION_COLUMNS = `s.*,
  (SELECT COUNT(*) FROM exercises e WHERE e.session_id = s.id) AS asked,
  (SELECT COUNT(*) FROM exercises e WHERE e.session_id = s.id AND e.answer IS NOT NULL) AS answered`;

function toOffer(row: OfferRecord): Offer {
  return {
    id: row.id,
    threadId: row.thread_id,
    trigger: row.trigger as Offer["trigger"],
    topic: row.topic,
    refs: parseRefs(row.refs),
    createdAt: row.created_at,
    seenAt: row.seen_at,
  };
}

function toSession(row: SessionRecord): SessionRow {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    topic: row.topic,
    trigger: row.trigger,
    sourceThreadId: row.source_thread_id,
    threadId: row.thread_id,
    pauseReason: row.pause_reason,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    asked: row.asked,
    answered: row.answered,
    projectKey: row.project_key,
    projectId: row.project_id,
    refs: parseRefs(row.refs),
    offerId: row.offer_id,
    concepts: parseStrings(row.concepts),
  };
}

function toExercise(row: ExerciseRecord): Exercise {
  return {
    ordinal: row.ordinal,
    type: row.type,
    question: row.question,
    files: parseStrings(row.files),
    askedAt: row.asked_at,
    answer: row.answer,
    confidence: row.confidence,
    skipped: row.skipped === 1,
    stuck: row.stuck,
    answeredAt: row.answered_at,
    verdict: row.verdict,
    gap: row.gap,
    form: parseJson(row.form, readAnswerForm),
    fields: parseJson(row.fields, (value) => {
      const parsed = FormValuesSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }),
    // The feedback the agent passed wins; a reply read from the log stands in for it. "" is a reply read
    // and found empty (`unreadReplies`); the app sees no reply either way.
    reply: row.feedback ?? (row.reply === null || row.reply === "" ? null : row.reply),
  };
}

/** Strips a session row down to what the app sees. */
export function publicSession(row: SessionRow): Session {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    topic: row.topic,
    trigger: row.trigger,
    sourceThreadId: row.sourceThreadId,
    threadId: row.threadId,
    pauseReason: row.pauseReason,
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    asked: row.asked,
    answered: row.answered,
  };
}

export class LearningStore {
  constructor(private readonly db: Database.Database) {}

  // ── offers ────────────────────────────────────────────────────────────────

  /** The thread's live offer, if any. */
  liveOffer(threadId: string): Offer | null {
    const row = this.db.prepare(`SELECT * FROM offers WHERE thread_id = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1`).get(threadId) as OfferRecord | undefined;
    return row === undefined ? null : toOffer(row);
  }

  offer(offerId: string): (Offer & { projectKey: string; status: string }) | null {
    const row = this.db.prepare(`SELECT * FROM offers WHERE id = ?`).get(offerId) as OfferRecord | undefined;
    return row === undefined ? null : { ...toOffer(row), projectKey: row.project_key, status: row.status };
  }

  /** Stores a new live offer; the thread's older live one is superseded (one live offer per thread). */
  createOffer(input: { threadId: string; projectKey: string; trigger: TriggerKind; topic: string; refs: Refs; now: number }): Offer {
    const id = newId("off");
    this.db.transaction(() => {
      this.db.prepare(`UPDATE offers SET status = 'superseded' WHERE thread_id = ? AND status = 'live'`).run(input.threadId);
      this.db
        .prepare(`INSERT INTO offers (id, thread_id, project_key, trigger, topic, refs, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`)
        .run(id, input.threadId, input.projectKey, input.trigger, input.topic, JSON.stringify(input.refs), input.now);
    })();
    return this.liveOffer(input.threadId)!;
  }

  /** Every live offer, oldest first. */
  liveOffers(): (Offer & { projectKey: string })[] {
    const rows = this.db.prepare(`SELECT * FROM offers WHERE status = 'live' ORDER BY created_at`).all() as OfferRecord[];
    return rows.map((row) => ({ ...toOffer(row), projectKey: row.project_key }));
  }

  /** Marks an offer seen once; answers true only the first time. */
  markSeen(offerId: string, now: number): boolean {
    return this.db.prepare(`UPDATE offers SET seen_at = ? WHERE id = ? AND status = 'live' AND seen_at IS NULL`).run(now, offerId).changes > 0;
  }

  /** Answers a live offer; false when it was not live any more. */
  answerOffer(offerId: string, answer: OfferAnswer, now: number): boolean {
    return this.db.prepare(`UPDATE offers SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'live'`).run(answer, now, offerId).changes > 0;
  }

  /** Expires the thread's live offer; answers the threads whose offer it was. */
  expireThreadOffers(threadId: string): number {
    return this.db.prepare(`UPDATE offers SET status = 'expired' WHERE thread_id = ? AND status = 'live'`).run(threadId).changes;
  }

  /** Expires one live offer; true when it was live. */
  expireOffer(offerId: string): boolean {
    return this.db.prepare(`UPDATE offers SET status = 'expired' WHERE id = ? AND status = 'live'`).run(offerId).changes > 0;
  }

  /** Expires every live offer in a project, or everywhere when `projectKey` is null. */
  expireLiveOffers(projectKey: string | null): number {
    return projectKey === null
      ? this.db.prepare(`UPDATE offers SET status = 'expired' WHERE status = 'live'`).run().changes
      : this.db.prepare(`UPDATE offers SET status = 'expired' WHERE status = 'live' AND project_key = ?`).run(projectKey).changes;
  }

  /** Expires live offers created at or before `before`; answers the threads they were in. */
  expireOffersBefore(before: number): string[] {
    const rows = this.db.prepare(`SELECT thread_id FROM offers WHERE status = 'live' AND created_at <= ?`).all(before) as { thread_id: string }[];
    this.db.prepare(`UPDATE offers SET status = 'expired' WHERE status = 'live' AND created_at <= ?`).run(before);
    return [...new Set(rows.map((row) => row.thread_id))];
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(input: {
    mode: SessionMode;
    projectKey: string;
    projectId: string;
    sourceThreadId: string | null;
    topic: string;
    trigger: TriggerKind;
    refs: Refs;
    offerId: string | null;
    briefVersion: string;
    now: number;
  }): SessionRow {
    const id = newId("ses");
    this.db
      .prepare(
        `INSERT INTO sessions (id, mode, state, project_key, project_id, source_thread_id, thread_id, topic, trigger, refs, offer_id, brief_version, created_at, updated_at)
         VALUES (?, ?, 'starting', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.mode, input.projectKey, input.projectId, input.sourceThreadId, input.topic, input.trigger, JSON.stringify(input.refs), input.offerId, input.briefVersion, input.now, input.now);
    return this.session(id)!;
  }

  session(sessionId: string): SessionRow | null {
    const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`).get(sessionId) as SessionRecord | undefined;
    return row === undefined ? null : toSession(row);
  }

  /** The open session living in a thread (a fork, or the work thread in "here" mode). */
  sessionInThread(threadId: string): SessionRow | null {
    const placeholders = OPEN_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.thread_id = ? AND s.state IN (${placeholders}) ORDER BY s.created_at DESC LIMIT 1`)
      .get(threadId, ...OPEN_STATES) as SessionRecord | undefined;
    return row === undefined ? null : toSession(row);
  }

  /** The open session started from a thread, wherever it runs. */
  openSessionFrom(threadId: string): SessionRow | null {
    const placeholders = OPEN_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.source_thread_id = ? AND s.state IN (${placeholders}) ORDER BY s.created_at DESC LIMIT 1`)
      .get(threadId, ...OPEN_STATES) as SessionRecord | undefined;
    return row === undefined ? null : toSession(row);
  }

  /** Whether any thread was ever a session thread (so the tab shows in it after the session ends). */
  everHostedSession(threadId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM sessions WHERE thread_id = ? LIMIT 1`).get(threadId) !== undefined;
  }

  finishedSessionsFrom(threadId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE source_thread_id = ? AND state = 'finished' AND trigger <> 'orientation'`).get(threadId) as { n: number }).n;
  }

  /** A session in the project is starting, mid-turn or waiting for an answer. */
  sessionActiveInProject(projectKey: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM sessions WHERE project_key = ? AND state IN ('starting', 'active', 'awaiting-answer') LIMIT 1`).get(projectKey) !== undefined
    );
  }

  sessionsInProject(projectKey: string, states: readonly SessionState[], limit: number): SessionRow[] {
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.project_key = ? AND s.state IN (${placeholders}) ORDER BY s.updated_at DESC LIMIT ?`)
      .all(projectKey, ...states, limit) as SessionRecord[];
    return rows.map(toSession);
  }

  sessionsInState(states: readonly SessionState[]): SessionRow[] {
    const placeholders = states.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.state IN (${placeholders})`).all(...states) as SessionRecord[]).map(toSession);
  }

  /**
   * Moves a session to `to` only while it is in one of `from`; false when something else moved it first
   * (a pause, a card opened by an early tool call, another copy of the plugin).
   */
  transition(sessionId: string, from: readonly SessionState[], to: SessionState, now: number, pauseReason: string | null = null): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const finished = to === "finished" || to === "abandoned" ? now : null;
    return (
      this.db
        .prepare(`UPDATE sessions SET state = ?, pause_reason = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE id = ? AND state IN (${placeholders})`)
        .run(to, to === "paused" ? pauseReason : null, now, finished, sessionId, ...from).changes > 0
    );
  }

  /** Binds a session to its thread unless it is bound already. */
  bindSessionThread(sessionId: string, threadId: string, now: number): void {
    this.db.prepare(`UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ? AND thread_id IS NULL`).run(threadId, now, sessionId);
  }

  setSessionThread(sessionId: string, threadId: string, now: number): void {
    this.db.prepare(`UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ?`).run(threadId, now, sessionId);
  }

  setSessionMode(sessionId: string, mode: SessionMode, now: number): void {
    this.db.prepare(`UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?`).run(mode, now, sessionId);
  }

  /** Moves a session to `state`; `pauseReason` is kept only for `paused`. */
  setSessionState(sessionId: string, state: SessionState, now: number, pauseReason: string | null = null): void {
    const finished = state === "finished" || state === "abandoned" ? now : null;
    this.db
      .prepare(`UPDATE sessions SET state = ?, pause_reason = ?, updated_at = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`)
      .run(state, state === "paused" ? pauseReason : null, now, finished, sessionId);
  }

  finishSession(sessionId: string, summary: string | null, concepts: readonly string[], now: number): void {
    this.db
      .prepare(`UPDATE sessions SET state = 'finished', summary = COALESCE(?, summary), concepts = ?, pause_reason = NULL, updated_at = ?, finished_at = ? WHERE id = ?`)
      .run(summary, JSON.stringify([...new Set(concepts)].slice(0, 50)), now, now, sessionId);
  }

  addConcepts(sessionId: string, concepts: readonly string[]): void {
    const session = this.session(sessionId);
    if (session === null || concepts.length === 0) return;
    const merged = [...new Set([...session.concepts, ...concepts])].slice(0, 50);
    this.db.prepare(`UPDATE sessions SET concepts = ? WHERE id = ?`).run(JSON.stringify(merged), sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId).changes > 0;
  }

  // ── exercises ─────────────────────────────────────────────────────────────

  exercises(sessionId: string): Exercise[] {
    return (this.db.prepare(`SELECT * FROM exercises WHERE session_id = ? ORDER BY ordinal`).all(sessionId) as ExerciseRecord[]).map(toExercise);
  }

  /** The last question, when it has no answer and was not skipped. */
  openExercise(sessionId: string): Exercise | null {
    const row = this.db
      .prepare(`SELECT * FROM exercises WHERE session_id = ? AND answered_at IS NULL AND skipped = 0 ORDER BY ordinal DESC LIMIT 1`)
      .get(sessionId) as ExerciseRecord | undefined;
    return row === undefined ? null : toExercise(row);
  }

  addExercise(sessionId: string, input: { type: ExerciseType; question: string; files: readonly string[]; form?: AnswerForm | null; now: number }): Exercise {
    const next = (this.db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM exercises WHERE session_id = ?`).get(sessionId) as { n: number }).n;
    this.db
      .prepare(`INSERT INTO exercises (session_id, ordinal, type, question, files, form, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, next, input.type, input.question, JSON.stringify(input.files), input.form == null ? null : JSON.stringify(input.form), input.now);
    return this.exercises(sessionId).find((exercise) => exercise.ordinal === next)!;
  }

  /** `fields` is a form answer by field id; `text` is then its summary. */
  recordAnswer(sessionId: string, ordinal: number, answer: { text: string; confidence: number; fields?: FormValues | null } | "skip", now: number): void {
    // The draft goes with the question: an answered or skipped question has nothing left unsent.
    if (answer === "skip") {
      this.db.prepare(`UPDATE exercises SET skipped = 1, answered_at = ?, draft = NULL WHERE session_id = ? AND ordinal = ?`).run(now, sessionId, ordinal);
      return;
    }
    this.db
      .prepare(`UPDATE exercises SET answer = ?, confidence = ?, fields = ?, answered_at = ?, draft = NULL WHERE session_id = ? AND ordinal = ?`)
      .run(answer.text, answer.confidence, answer.fields == null ? null : JSON.stringify(answer.fields), now, sessionId, ordinal);
  }

  /**
   * Questions answered or skipped whose reply was never read (a store from before replies were kept, a
   * failed read) and that have no feedback passed with the verdict.
   */
  unreadReplies(sessionId: string): number[] {
    return (this.db.prepare(`SELECT ordinal FROM exercises WHERE session_id = ? AND answered_at IS NOT NULL AND reply IS NULL AND feedback IS NULL ORDER BY ordinal`).all(sessionId) as { ordinal: number }[]).map(
      (row) => row.ordinal,
    );
  }

  /**
   * Keeps the agent's reply to a question (its feedback), from a complete read, replacing an earlier one
   * and ending any unfinished read; "" when it wrote nothing.
   */
  recordReply(sessionId: string, ordinal: number, reply: string): void {
    this.db.prepare(`UPDATE exercises SET reply = ?, reply_progress = NULL WHERE session_id = ? AND ordinal = ?`).run(reply, sessionId, ordinal);
  }

  /** Whether the agent passed feedback text with its verdict on this question. */
  hasFeedback(sessionId: string, ordinal: number): boolean {
    return this.db.prepare(`SELECT 1 FROM exercises WHERE session_id = ? AND ordinal = ? AND feedback IS NOT NULL`).get(sessionId, ordinal) !== undefined;
  }

  /**
   * The feedback cards of a thread's sessions, oldest first: every question whose verdict was recorded in a
   * known turn and that has feedback, passed with the verdict or read from the log.
   */
  feedbackCards(threadId: string): { sessionId: string; ordinal: number; turnId: string; verdict: Verdict | null; feedback: string }[] {
    const rows = this.db
      .prepare(
        `SELECT e.session_id AS sessionId, e.ordinal, e.feedback_turn AS turnId, e.verdict, COALESCE(e.feedback, NULLIF(e.reply, '')) AS feedback
           FROM exercises e JOIN sessions s ON s.id = e.session_id
           WHERE s.thread_id = ? AND e.feedback_turn IS NOT NULL AND COALESCE(e.feedback, NULLIF(e.reply, '')) IS NOT NULL
           ORDER BY s.created_at, e.ordinal`,
      )
      .all(threadId) as { sessionId: string; ordinal: number; turnId: string; verdict: Verdict | null; feedback: string }[];
    return rows;
  }

  /** Where an unfinished read of a question's reply stopped, and what it had found; null when none is under way. */
  replyProgress(sessionId: string, ordinal: number): ReplyProgress | null {
    const row = this.db.prepare(`SELECT reply_progress FROM exercises WHERE session_id = ? AND ordinal = ?`).get(sessionId, ordinal) as { reply_progress: string | null } | undefined;
    return parseJson(row?.reply_progress ?? null, (value) => {
      const parsed = ReplyProgressSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    });
  }

  /** Saves how far a read that ran out of pages got; the reply stays unread. */
  recordReplyProgress(sessionId: string, ordinal: number, progress: ReplyProgress): void {
    this.db.prepare(`UPDATE exercises SET reply_progress = ? WHERE session_id = ? AND ordinal = ? AND reply IS NULL`).run(JSON.stringify(progress), sessionId, ordinal);
  }

  /**
   * Saves an open question's draft: the last save wins (the app sends one question's saves one at a time,
   * in order). A question answered or skipped meanwhile keeps none. Answers whether it was saved.
   */
  recordDraft(sessionId: string, ordinal: number, draft: CardDraft, now: number, writer: string | null = null): boolean {
    return (
      this.db
        .prepare(
          `UPDATE exercises SET draft = ?, draft_saved_at = MAX(?, COALESCE(draft_saved_at, 0) + 1), draft_writer = ?
             WHERE session_id = ? AND ordinal = ? AND answered_at IS NULL AND skipped = 0`,
        )
        .run(JSON.stringify(draft), now, writer, sessionId, ordinal).changes > 0
    );
  }

  /**
   * The stored draft's token (when it was saved, rising per question) and the browser that saved it last;
   * nulls when the question has none.
   */
  draftStamp(sessionId: string, ordinal: number): { token: number | null; writer: string | null } {
    const row = this.db
      .prepare(
        `SELECT draft_saved_at AS token, draft_writer AS writer FROM exercises
           WHERE session_id = ? AND ordinal = ? AND answered_at IS NULL AND skipped = 0 AND draft IS NOT NULL`,
      )
      .get(sessionId, ordinal) as { token: number | null; writer: string | null } | undefined;
    return { token: row?.token ?? null, writer: row?.writer ?? null };
  }

  /** The stored draft's token alone. */
  draftToken(sessionId: string, ordinal: number): number | null {
    return this.draftStamp(sessionId, ordinal).token;
  }

  /** An open question's saved draft, as stored; null when there is none or it no longer reads. */
  draft(sessionId: string, ordinal: number): CardDraft | null {
    const row = this.db.prepare(`SELECT draft FROM exercises WHERE session_id = ? AND ordinal = ? AND answered_at IS NULL AND skipped = 0`).get(sessionId, ordinal) as
      | { draft: string | null }
      | undefined;
    return parseJson(row?.draft ?? null, (value) => {
      const parsed = CardDraftSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    });
  }

  recordStuck(sessionId: string, ordinal: number): void {
    this.db.prepare(`UPDATE exercises SET stuck = stuck + 1 WHERE session_id = ? AND ordinal = ?`).run(sessionId, ordinal);
  }

  /**
   * The agent's verdict on the latest answered question (or `ordinal`), with the feedback it passed and the
   * turn it was recorded in. A later verdict on the same question replaces the earlier one; one with no
   * feedback or no known turn keeps what an earlier call stored.
   */
  recordVerdict(
    sessionId: string,
    verdict: Verdict,
    gap: string | null,
    ordinal?: number,
    feedback: { text: string | null; turnId: string | null } = { text: null, turnId: null },
  ): number | null {
    const target =
      ordinal ??
      (this.db.prepare(`SELECT MAX(ordinal) AS n FROM exercises WHERE session_id = ? AND answered_at IS NOT NULL`).get(sessionId) as { n: number | null }).n;
    if (target === null) return null;
    const changed = this.db
      .prepare(`UPDATE exercises SET verdict = ?, gap = ?, feedback = COALESCE(?, feedback), feedback_turn = COALESCE(?, feedback_turn) WHERE session_id = ? AND ordinal = ?`)
      .run(verdict, gap, feedback.text, feedback.turnId, sessionId, target).changes;
    return changed > 0 ? target : null;
  }

  // ── per-thread state ──────────────────────────────────────────────────────

  thread(threadId: string): ThreadRow {
    const row = this.db.prepare(`SELECT * FROM thread_state WHERE thread_id = ?`).get(threadId) as
      | { thread_id: string; opt_out: number; snooze_until: number | null; snooze_until_turn: number | null; completed_turns: number; changed_turns_since_offer: number }
      | undefined;
    return {
      threadId,
      optOut: row?.opt_out === 1,
      snoozeUntil: row?.snooze_until ?? null,
      snoozeUntilTurn: row?.snooze_until_turn ?? null,
      completedTurns: row?.completed_turns ?? 0,
      changedTurnsSinceOffer: row?.changed_turns_since_offer ?? 0,
    };
  }

  /** Counts a completed turn; `changed` when it changed files. Answers the updated row. */
  countTurn(threadId: string, changed: boolean): ThreadRow {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, completed_turns, changed_turns_since_offer) VALUES (?, 1, ?)
         ON CONFLICT(thread_id) DO UPDATE SET completed_turns = completed_turns + 1, changed_turns_since_offer = changed_turns_since_offer + excluded.changed_turns_since_offer`,
      )
      .run(threadId, changed ? 1 : 0);
    return this.thread(threadId);
  }

  /** Remembers the commits a turn made (oldest first), keeping the last five. */
  recordCommits(threadId: string, commits: readonly { sha: string; subject: string }[]): void {
    if (commits.length === 0) return;
    const kept = [...this.lastCommits(threadId).reverse(), ...commits].slice(-5);
    this.db
      .prepare(`INSERT INTO thread_state (thread_id, last_commits) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET last_commits = excluded.last_commits`)
      .run(threadId, JSON.stringify(kept));
  }

  /** The thread's recorded commits, newest first. */
  lastCommits(threadId: string): { sha: string; subject: string }[] {
    const row = this.db.prepare(`SELECT last_commits FROM thread_state WHERE thread_id = ?`).get(threadId) as { last_commits: string | null } | undefined;
    if (row?.last_commits == null) return [];
    try {
      const parsed: unknown = JSON.parse(row.last_commits);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((commit): commit is { sha: string; subject: string } => typeof commit?.sha === "string" && typeof commit?.subject === "string")
        .reverse();
    } catch {
      return [];
    }
  }

  resetChangedTurns(threadId: string): void {
    this.db.prepare(`UPDATE thread_state SET changed_turns_since_offer = 0 WHERE thread_id = ?`).run(threadId);
  }

  setOptOut(threadId: string, optOut: boolean): void {
    this.db
      .prepare(`INSERT INTO thread_state (thread_id, opt_out) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET opt_out = excluded.opt_out`)
      .run(threadId, optOut ? 1 : 0);
  }

  optOuts(threadIds: readonly string[]): Set<string> {
    if (threadIds.length === 0) return new Set();
    const placeholders = threadIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT thread_id FROM thread_state WHERE opt_out = 1 AND thread_id IN (${placeholders})`).all(...threadIds) as { thread_id: string }[];
    return new Set(rows.map((row) => row.thread_id));
  }

  snooze(threadId: string, until: number, untilTurn: number): void {
    this.db
      .prepare(
        `INSERT INTO thread_state (thread_id, snooze_until, snooze_until_turn) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET snooze_until = excluded.snooze_until, snooze_until_turn = excluded.snooze_until_turn`,
      )
      .run(threadId, until, untilTurn);
  }

  // ── global values ─────────────────────────────────────────────────────────

  private getValue<T>(key: string, fallback: T): T {
    const row = this.db.prepare(`SELECT value FROM global_state WHERE key = ?`).get(key) as { value: string } | undefined;
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  private setValue(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO global_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  /**
   * The values the caps read. Answers are kept under `answeredAt`, which the last migration seeds once
   * from the answered offers 0.1.0 stored; the `seenAt` key 0.1.0 wrote (offers shown, answered or not)
   * is no longer read, so what was only shown counts for nothing.
   */
  global(now: number): GlobalState {
    const answered = this.getValue<unknown>("answeredAt", []);
    const answeredAt = Array.isArray(answered) ? answered.filter((at): at is number => typeof at === "number" && now - at < 2 * 24 * 3_600_000).sort((a, b) => a - b) : [];
    const laters = this.getValue<unknown>("consecutiveLaters", 0);
    const backoff = this.getValue<unknown>("backoffUntil", null);
    return {
      answeredAt,
      consecutiveLaters: typeof laters === "number" ? laters : 0,
      backoffUntil: typeof backoff === "number" ? backoff : null,
    };
  }

  /** An offer was answered: it counts toward the daily limit and the gap between offers. */
  recordAnswered(now: number): void {
    const { answeredAt } = this.global(now);
    this.setValue("answeredAt", [...answeredAt, now].slice(-50));
  }

  setBackoff(state: Pick<GlobalState, "consecutiveLaters" | "backoffUntil">): void {
    this.setValue("consecutiveLaters", state.consecutiveLaters);
    this.setValue("backoffUntil", state.backoffUntil);
  }

  neverProjects(): { key: string; name: string }[] {
    const value = this.getValue<unknown>("neverProjects", []);
    return Array.isArray(value)
      ? value.filter((entry): entry is { key: string; name: string } => typeof entry === "object" && entry !== null && typeof entry.key === "string" && typeof entry.name === "string")
      : [];
  }

  setNever(key: string, name: string, never: boolean): void {
    const rest = this.neverProjects().filter((entry) => entry.key !== key);
    this.setValue("neverProjects", never ? [...rest, { key, name }] : rest);
  }

  isNever(key: string): boolean {
    return this.neverProjects().some((entry) => entry.key === key);
  }

  /** The last pull request state read for an environment, with the thread that last ran there. */
  pullRequestState(environmentId: string): { state: string; threadId: string } | null {
    const all = this.getValue<Record<string, { state: string; threadId: string }>>("pullRequests", {});
    return all[environmentId] ?? null;
  }

  setPullRequestState(environmentId: string, value: { state: string; threadId: string } | null): void {
    const all = { ...this.getValue<Record<string, { state: string; threadId: string }>>("pullRequests", {}) };
    if (value === null) delete all[environmentId];
    else all[environmentId] = value;
    this.setValue("pullRequests", all);
  }

  watchedPullRequests(): { environmentId: string; state: string; threadId: string }[] {
    const all = this.getValue<Record<string, { state: string; threadId: string }>>("pullRequests", {});
    return Object.entries(all).map(([environmentId, value]) => ({ environmentId, ...value }));
  }
}
