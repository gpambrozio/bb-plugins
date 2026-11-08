/**
 * Storage for repo orientations (spec §4): one row per build and its ordered blocks (chapters, notes and
 * code listings), in the plugin's own SQLite beside `LearningStore`. A project has at most one live
 * (`starting` or `building`) row, enforced by a partial unique index, and at most one `ready` row,
 * enforced by `promoteReady`.
 */
import type Database from "better-sqlite3";

import {
  OrientationSummarySchema,
  type OrientationBlock,
  type OrientationDepth,
  type OrientationStatus,
  type OrientationSummary,
} from "../shared/orientation";
import type { ListingCheck } from "./orientation-verify";

export interface OrientationRow {
  id: string;
  projectKey: string;
  projectId: string;
  status: OrientationStatus;
  depth: OrientationDepth;
  sourceThreadId: string;
  environmentId: string | null;
  hostId: string | null;
  workspacePath: string | null;
  providerId: string;
  builderThreadId: string | null;
  headSha: string | null;
  title: string;
  summary: OrientationSummary | null;
  reminded: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  readyAt: number | null;
}

/** A stored block; a listing also carries the hash of the lines captured (`sha256`). */
export type BlockRow = (
  | Extract<OrientationBlock, { kind: "chapter" | "note" }>
  | (Extract<OrientationBlock, { kind: "listing" }> & { sha256: string })
) & { orientationId: string };

export type NewOrientation = Omit<OrientationRow, "status" | "builderThreadId" | "summary" | "reminded" | "error" | "updatedAt" | "readyAt">;

export interface NewListing {
  caption: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  sha256: string;
  ref: string | null;
}

interface OrientationRecord {
  id: string;
  project_key: string;
  project_id: string;
  status: OrientationStatus;
  depth: OrientationDepth;
  source_thread_id: string;
  environment_id: string | null;
  host_id: string | null;
  workspace_path: string | null;
  provider_id: string;
  builder_thread_id: string | null;
  head_sha: string | null;
  title: string;
  summary: string | null;
  reminded: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  ready_at: number | null;
}

interface BlockRecord {
  orientation_id: string;
  ordinal: number;
  kind: "chapter" | "note" | "listing";
  text: string | null;
  listing_no: number | null;
  caption: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  captured: string | null;
  captured_sha256: string | null;
  captured_ref: string | null;
  check_state: ListingCheckState | null;
  check_start: number | null;
  check_end: number | null;
  checked_at: number | null;
}

type ListingCheckState = ListingCheck["state"];

/** A summary of another shape reads as none rather than failing a whole listing. */
function parseSummary(raw: string | null): OrientationSummary | null {
  if (raw === null) return null;
  try {
    const parsed = OrientationSummarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toOrientation(row: OrientationRecord): OrientationRow {
  return {
    id: row.id,
    projectKey: row.project_key,
    projectId: row.project_id,
    status: row.status,
    depth: row.depth,
    sourceThreadId: row.source_thread_id,
    environmentId: row.environment_id,
    hostId: row.host_id,
    workspacePath: row.workspace_path,
    providerId: row.provider_id,
    builderThreadId: row.builder_thread_id,
    headSha: row.head_sha,
    title: row.title,
    summary: parseSummary(row.summary),
    reminded: row.reminded === 1,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
  };
}

function toBlock(row: BlockRecord): BlockRow {
  const orientationId = row.orientation_id;
  if (row.kind === "chapter") return { kind: "chapter", ordinal: row.ordinal, title: row.text ?? "", orientationId };
  if (row.kind === "note") return { kind: "note", ordinal: row.ordinal, markdown: row.text ?? "", orientationId };
  return {
    kind: "listing",
    ordinal: row.ordinal,
    number: row.listing_no ?? 0,
    caption: row.caption ?? "",
    path: row.path ?? "",
    startLine: row.start_line ?? 0,
    endLine: row.end_line ?? 0,
    text: row.captured ?? "",
    sha256: row.captured_sha256 ?? "",
    ref: row.captured_ref,
    check:
      row.check_state === null
        ? null
        : { state: row.check_state, startLine: row.check_start, endLine: row.check_end, checkedAt: row.checked_at ?? 0 },
    orientationId,
  };
}

export class OrientationStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Inserts a `starting` row. A second live row for the project throws SQLite's UNIQUE error unchanged:
   * the caller maps it to "already building".
   */
  create(input: NewOrientation): OrientationRow {
    this.db
      .prepare(
        `INSERT INTO orientations (id, project_key, project_id, status, depth, source_thread_id, environment_id, host_id, workspace_path, provider_id, head_sha, title, created_at, updated_at)
         VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectKey,
        input.projectId,
        input.depth,
        input.sourceThreadId,
        input.environmentId,
        input.hostId,
        input.workspacePath,
        input.providerId,
        input.headSha,
        input.title,
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id)!;
  }

  get(id: string): OrientationRow | null {
    return this.one(`SELECT * FROM orientations WHERE id = ?`, id);
  }

  /** The project's orientation being built, if any. */
  live(projectKey: string): OrientationRow | null {
    return this.one(`SELECT * FROM orientations WHERE project_key = ? AND status IN ('starting', 'building') LIMIT 1`, projectKey);
  }

  /** The project's newest ready orientation. */
  ready(projectKey: string): OrientationRow | null {
    return this.one(`SELECT * FROM orientations WHERE project_key = ? AND status = 'ready' ORDER BY ready_at DESC, created_at DESC LIMIT 1`, projectKey);
  }

  /** The project's failed or cancelled orientation that ended last, if any. */
  latestEnded(projectKey: string): OrientationRow | null {
    return this.one(
      `SELECT * FROM orientations WHERE project_key = ? AND status IN ('failed', 'cancelled') ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      projectKey,
    );
  }

  byBuilder(threadId: string): OrientationRow | null {
    return this.one(`SELECT * FROM orientations WHERE builder_thread_id = ? ORDER BY created_at DESC LIMIT 1`, threadId);
  }

  /** Every orientation being built, oldest first. */
  allLive(): OrientationRow[] {
    const rows = this.db.prepare(`SELECT * FROM orientations WHERE status IN ('starting', 'building') ORDER BY created_at`).all() as OrientationRecord[];
    return rows.map(toOrientation);
  }

  /** Binds the builder thread, only while none is bound. */
  bindBuilder(id: string, threadId: string, now: number): boolean {
    return this.db.prepare(`UPDATE orientations SET builder_thread_id = ?, updated_at = ? WHERE id = ? AND builder_thread_id IS NULL`).run(threadId, now, id).changes === 1;
  }

  /** Moves the row from one of `from` to `to`; false, with nothing changed, when it is in another status. */
  transition(id: string, from: readonly OrientationStatus[], to: OrientationStatus, now: number, error: string | null = null): boolean {
    const placeholders = from.map(() => "?").join(", ");
    return (
      this.db
        .prepare(`UPDATE orientations SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(to, error, now, id, ...from).changes === 1
    );
  }

  setSummary(id: string, summary: OrientationSummary, now: number): void {
    this.db.prepare(`UPDATE orientations SET summary = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(summary), now, id);
  }

  /** Marks the one idle reminder sent; false when it already was. */
  markReminded(id: string, now: number): boolean {
    return this.db.prepare(`UPDATE orientations SET reminded = 1, updated_at = ? WHERE id = ? AND reminded = 0`).run(now, id).changes === 1;
  }

  appendChapter(id: string, title: string, now: number): BlockRow {
    return this.append(id, now, (ordinal) => {
      this.db.prepare(`INSERT INTO orientation_blocks (orientation_id, ordinal, kind, text) VALUES (?, ?, 'chapter', ?)`).run(id, ordinal, title);
    });
  }

  appendNote(id: string, markdown: string, now: number): BlockRow {
    return this.append(id, now, (ordinal) => {
      this.db.prepare(`INSERT INTO orientation_blocks (orientation_id, ordinal, kind, text) VALUES (?, ?, 'note', ?)`).run(id, ordinal, markdown);
    });
  }

  appendListing(id: string, listing: NewListing, now: number): BlockRow {
    return this.append(id, now, (ordinal) => {
      const row = this.db.prepare(`SELECT next_listing FROM orientations WHERE id = ?`).get(id) as { next_listing: number };
      this.db.prepare(`UPDATE orientations SET next_listing = next_listing + 1 WHERE id = ?`).run(id);
      this.db
        .prepare(
          `INSERT INTO orientation_blocks (orientation_id, ordinal, kind, listing_no, caption, path, start_line, end_line, captured, captured_sha256, captured_ref)
           VALUES (?, ?, 'listing', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ordinal, row.next_listing, listing.caption, listing.path, listing.startLine, listing.endLine, listing.text, listing.sha256, listing.ref);
    });
  }

  /** Removes the last block, if any. Its ordinal and listing number are not handed out again. */
  pop(id: string, now: number): BlockRow | null {
    return this.db.transaction((): BlockRow | null => {
      const last = this.db.prepare(`SELECT * FROM orientation_blocks WHERE orientation_id = ? ORDER BY ordinal DESC LIMIT 1`).get(id) as BlockRecord | undefined;
      if (last === undefined) return null;
      this.db.prepare(`DELETE FROM orientation_blocks WHERE orientation_id = ? AND ordinal = ?`).run(id, last.ordinal);
      this.db.prepare(`UPDATE orientations SET updated_at = ? WHERE id = ?`).run(now, id);
      return toBlock(last);
    })();
  }

  blocks(id: string): BlockRow[] {
    const rows = this.db.prepare(`SELECT * FROM orientation_blocks WHERE orientation_id = ? ORDER BY ordinal`).all(id) as BlockRecord[];
    return rows.map(toBlock);
  }

  counts(id: string): { blocks: number; listings: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS blocks, COALESCE(SUM(kind = 'listing'), 0) AS listings FROM orientation_blocks WHERE orientation_id = ?`)
      .get(id) as { blocks: number; listings: number };
    return { blocks: row.blocks, listings: row.listings };
  }

  /** Records the last verification of a listing. */
  setCheck(id: string, ordinal: number, check: ListingCheck, now: number): void {
    this.db
      .prepare(`UPDATE orientation_blocks SET check_state = ?, check_start = ?, check_end = ?, checked_at = ? WHERE orientation_id = ? AND ordinal = ? AND kind = 'listing'`)
      .run(check.state, check.startLine, check.endLine, now, id, ordinal);
  }

  /** Makes the row ready and deletes the project's older ready rows with their blocks, in one transaction. */
  promoteReady(id: string, now: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT project_key FROM orientations WHERE id = ?`).get(id) as { project_key: string } | undefined;
      if (row === undefined) return;
      this.db.prepare(`UPDATE orientations SET status = 'ready', ready_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
      // Blocks go with their orientation through ON DELETE CASCADE; deleted by hand as well in case a
      // connection runs without foreign keys.
      this.db.prepare(`DELETE FROM orientation_blocks WHERE orientation_id IN (SELECT id FROM orientations WHERE project_key = ? AND status = 'ready' AND id <> ?)`).run(row.project_key, id);
      this.db.prepare(`DELETE FROM orientations WHERE project_key = ? AND status = 'ready' AND id <> ?`).run(row.project_key, id);
    })();
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM orientation_blocks WHERE orientation_id = ?`).run(id);
      this.db.prepare(`DELETE FROM orientations WHERE id = ?`).run(id);
    })();
  }

  /** Deletes failed and cancelled rows last updated before `before`; returns how many. */
  purge(before: number): number {
    return this.db.transaction(() => {
      const stale = `SELECT id FROM orientations WHERE status IN ('failed', 'cancelled') AND updated_at < ?`;
      this.db.prepare(`DELETE FROM orientation_blocks WHERE orientation_id IN (${stale})`).run(before);
      return this.db.prepare(`DELETE FROM orientations WHERE status IN ('failed', 'cancelled') AND updated_at < ?`).run(before).changes;
    })();
  }

  /** Takes the next ordinal (which only rises), runs `insert` with it and returns the stored block. */
  private append(id: string, now: number, insert: (ordinal: number) => void): BlockRow {
    return this.db.transaction((): BlockRow => {
      const row = this.db.prepare(`SELECT next_ordinal FROM orientations WHERE id = ?`).get(id) as { next_ordinal: number } | undefined;
      if (row === undefined) throw new Error(`No orientation ${id}`);
      this.db.prepare(`UPDATE orientations SET next_ordinal = next_ordinal + 1, updated_at = ? WHERE id = ?`).run(now, id);
      insert(row.next_ordinal);
      const stored = this.db.prepare(`SELECT * FROM orientation_blocks WHERE orientation_id = ? AND ordinal = ?`).get(id, row.next_ordinal) as BlockRecord;
      return toBlock(stored);
    })();
  }

  private one(sql: string, ...params: unknown[]): OrientationRow | null {
    const row = this.db.prepare(sql).get(...params) as OrientationRecord | undefined;
    return row === undefined ? null : toOrientation(row);
  }
}
