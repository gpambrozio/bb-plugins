import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MIGRATIONS, ReviewStore } from "./store";

function store() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return { db, store: new ReviewStore(db) };
}

const rows = (db: Database.Database, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("deleting a session", () => {
  it("takes everything of it, and leaves the other sessions alone", () => {
    const { db, store: reviews } = store();
    const fill = (environmentId: string) => {
      const session = reviews.session(environmentId, "uncommitted");
      const thread = reviews.createThread({ sessionId: session.id, filePath: "a.ts", side: "new", startLine: 1, endLine: 1, severity: null, anchorContent: null, body: "Why?" });
      reviews.addComment({ threadId: thread.id, authorType: "agent", authorName: "AI", body: "Because." });
      reviews.recordSend(session.id, "thr_1", [thread.id], "");
      reviews.createRun({ sessionId: session.id, kind: "review", bbThreadId: "thr_run", reviewThreadId: null, focus: null, providerId: "claude-code", model: null, status: "running", parentThreadId: "thr_1" });
      reviews.saveViewState("thr_1", session.id, { savedAt: 1 });
      return session;
    };
    const gone = fill("env_gone");
    fill("env_kept");
    const tables = ["review_sessions", "review_threads", "review_comments", "sends", "send_previous", "runs", "view_states"];
    const before = Object.fromEntries(tables.map((table) => [table, rows(db, table)]));
    for (const table of tables) expect(before[table], table).toBeGreaterThan(0);

    const open = reviews.deleteSession(gone.id);
    expect(open.map((run) => run.threadId)).toEqual(["thr_run"]);
    // Half of every table went: the other session's rows are all still there.
    expect(Object.fromEntries(tables.map((table) => [table, rows(db, table)]))).toEqual(Object.fromEntries(tables.map((table) => [table, before[table]! / 2])));
    expect(reviews.sessionById(gone.id)).toBeNull();
  });
});
