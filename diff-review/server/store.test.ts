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

describe("mirroring GitHub's threads", () => {
  it("keeps one row per GitHub comment, dropping a second copy of one", () => {
    const { db, store: reviews } = store();
    const session = reviews.session("env_1", "pr:o/r#7");
    const remote = {
      githubThreadId: "PRRT_1", filePath: "a.ts", side: "new" as const, startLine: 1, endLine: 1, status: "open" as const, anchorContent: null,
      comments: [{ githubCommentId: "PRRC_1", author: "octo", body: "Why?", createdAt: 1 }],
    };
    reviews.syncGithubThreads(session.id, [remote]);
    const [thread] = reviews.threads(session.id);
    // A copy of the same GitHub comment, as an import racing a draft's adoption once left.
    db.prepare("INSERT INTO review_comments (id, thread_id, author_type, author_name, body, created_at, github_comment_id) VALUES ('copy', ?, 'user', 'octo', 'Why?', 2, 'PRRC_1')").run(thread!.id);
    expect(reviews.syncGithubThreads(session.id, [remote])).toBe(true);
    expect(reviews.threads(session.id)[0]!.comments.map((comment) => [comment.id === "copy", comment.body])).toEqual([[false, "Why?"]]);
    expect(reviews.syncGithubThreads(session.id, [remote])).toBe(false);
  });

  it("folds a second thread for one GitHub thread into the first, with its comments, send, runs and drafts", () => {
    const { db, store: reviews } = store();
    const session = reviews.session("env_1", "pr:o/r#7");
    const draft = { body: "", severity: null, range: null };
    // The line comment Submit made into PRRT_9, linked, beside the copy a read imported first (as before 0.5.1).
    const kept = reviews.createThread({ sessionId: session.id, filePath: "a.ts", side: "new", startLine: 1, endLine: 1, severity: null, anchorContent: "a", body: "Name it c." });
    reviews.addComment({ threadId: kept.id, authorType: "user", authorName: "You", body: "Mine, unposted." });
    const remote = {
      githubThreadId: "PRRT_9", filePath: "a.ts", side: "new" as const, startLine: 1, endLine: 1, status: "open" as const, anchorContent: "a",
      comments: [{ githubCommentId: "PRRC_9", author: "me", body: "Name it c.", createdAt: 1 }],
    };
    reviews.syncGithubThreads(session.id, [remote]);
    const copy = reviews.threads(session.id).find((thread) => thread.id !== kept.id)!;
    db.prepare("UPDATE review_threads SET github_thread_id = 'PRRT_9' WHERE id = ?").run(kept.id);
    db.prepare("UPDATE review_comments SET github_comment_id = 'PRRC_9' WHERE id = ?").run(kept.comments[0]!.id);
    // What was done on the copy meanwhile: an agent's draft, a send, a run, a reply typed in a tab.
    reviews.addComment({ threadId: copy.id, authorType: "agent", authorName: "AI", body: "On the copy." });
    reviews.recordSend(session.id, "thr_1", [copy.id], "");
    const run = reviews.createRun({ sessionId: session.id, kind: "mention", bbThreadId: "thr_run", reviewThreadId: copy.id, focus: null, providerId: "claude-code", model: null, status: "running" });
    reviews.saveViewState("thr_1", session.id, { savedAt: 1, drafts: { [`reply:${copy.id}`]: { ...draft, body: "Typed on the copy" } }, expandedThreads: { [copy.id]: true }, collapsed: {}, scroll: null } as never);
    expect(reviews.threads(session.id).filter((thread) => thread.githubThreadId === "PRRT_9")).toHaveLength(2);

    expect(reviews.syncGithubThreads(session.id, [remote])).toBe(true);
    const threads = reviews.threads(session.id);
    expect(threads.map((thread) => thread.id)).toEqual([kept.id]);
    expect(threads[0]!.comments.map((comment) => [comment.authorType, comment.body])).toEqual([["github", "Name it c."], ["user", "Mine, unposted."], ["agent", "On the copy."]]);
    expect(threads[0]!.delivery).toMatchObject({ state: "sent", threadId: "thr_1" });
    expect(reviews.run(run.id)!.reviewThreadId).toBe(kept.id);
    expect(reviews.viewState("thr_1", session.id)).toMatchObject({ drafts: { [`reply:${kept.id}`]: { body: "Typed on the copy" } }, expandedThreads: { [kept.id]: true } });
    expect(reviews.syncGithubThreads(session.id, [remote])).toBe(false);
  });
});
