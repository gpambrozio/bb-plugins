/**
 * Upgrading a store from e54db75 (the build the owner first installed), whose Start race could leave
 * two open sessions for one source thread (review pass 2, finding 11).
 */
import { createHash } from "node:crypto";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "../server";
import { LearningStore, MIGRATIONS, reconcileOpenSessions } from "./store";

const sha = (statement: string) => createHash("sha256").update(statement).digest("hex");

/** What bb recorded for e54db75's nine migrations, and for migration 9 in the dev install of the draft. */
const E54DB75_HASHES = [
  "932906ce983caef1fbf3480a4288321764ef5ab9b97755fffcd0edc072ab4e95",
  "af55c76195c80512bda89328c3045f57e0148a4d82638cc75e655bbd01650048",
  "6b278ac6880d91bc5061c68dda786ce55a9d23f0dae8527834265bfd387af057",
  "052dafff193ec7fd67e9c122cdd9e55926642605387932bc5993216c8f80091c",
  "d5f150bec94417b626bd0316236f2e4a67149860c1179324462fb09a234767fb",
  "1d460cbba6193a28b4c29fc45606646c401eaf2f2e5a3488f042bfc06633ae15",
  "52b296b7a75a3e0cc3e2489432779981e1addd024fd57ce3131f97ff4c8e1475",
  "3aa935a349b1078a9f224a246500aad4d733555aa93b11e5b0a2e88902ac123e",
  "439cb7a9798ad88faa4a032890648875dc4358ce1eecb1beb6d6fc6344509b4e",
];
const INDEX_HASH = "c76591abb425d1ee705490d6edb6c4f802d15c4ad9361badce89a66eec0e43af";

type Db = ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>;

function insertSession(db: Db, id: string, state: string, updatedAt: number) {
  db.prepare(
    `INSERT INTO sessions (id, mode, state, project_key, project_id, source_thread_id, thread_id, topic, trigger, refs, brief_version, created_at, updated_at)
     VALUES (?, 'fork', ?, 'k', 'proj_1', 'thr_work', ?, 't', 'commit', '{}', 'v', ?, ?)`,
  ).run(id, state, `thr_${id}`, updatedAt, updatedAt);
}

function answer(db: Db, sessionId: string, ordinal: number, text: string | null) {
  db.prepare(`INSERT INTO exercises (session_id, ordinal, type, question, files, asked_at, answer, confidence, answered_at) VALUES (?, ?, 'prediction', 'Q?', '[]', 1, ?, 3, ?)`).run(
    sessionId,
    ordinal,
    text,
    text === null ? null : 2,
  );
}

describe("migrations", () => {
  it("keep e54db75's nine statements as an unchanged prefix, and the index at position 9", () => {
    expect(MIGRATIONS.slice(0, 9).map(sha)).toEqual(E54DB75_HASHES);
    expect(sha(MIGRATIONS[9]!)).toBe(INDEX_HASH);
  });

  it("an e54db75 store with duplicate open sessions loads: one survives, the others are kept as history", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, 9));
    // The Start race: two open sessions for one source thread, both with answers.
    insertSession(db, "ses_old", "paused", 10);
    insertSession(db, "ses_new", "paused", 20);
    insertSession(db, "ses_answered", "active", 5);
    answer(db, "ses_old", 1, "first answer");
    answer(db, "ses_answered", 1, "kept");
    answer(db, "ses_answered", 2, "kept too");
    await plugin(bb);
    const store = new LearningStore(bb.storage.database());
    // Most progressed wins: running before paused.
    expect(store.session("ses_answered")?.state).toBe("active");
    expect(store.session("ses_old")?.state).toBe("abandoned");
    expect(store.session("ses_new")?.state).toBe("abandoned");
    expect(store.exercises("ses_old")[0]?.answer).toBe("first answer");
    expect(harness.logEntries.some((entry) => entry.message.includes("Closed 2 duplicate open learning session"))).toBe(true);
    // The index is in place now.
    expect(() => insertSession(bb.storage.database(), "ses_more", "paused", 30)).toThrow(/UNIQUE/);
  });

  it("among paused duplicates the one with more answers survives, then the newest", () => {
    const { bb } = createFakePluginHost({ pluginId: "learning-exercises" });
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, 9));
    insertSession(db, "ses_a", "paused", 10);
    insertSession(db, "ses_b", "paused", 30);
    insertSession(db, "ses_c", "paused", 20);
    answer(db, "ses_c", 1, "x");
    expect(reconcileOpenSessions(db, 99)).toBe(2);
    const store = new LearningStore(db);
    expect(["ses_a", "ses_b", "ses_c"].map((id) => store.session(id)?.state)).toEqual(["abandoned", "abandoned", "paused"]);
  });

  it("leaves a fresh store and a store that has the index alone", () => {
    const { bb } = createFakePluginHost({ pluginId: "learning-exercises" });
    const db = bb.storage.database();
    expect(reconcileOpenSessions(db, 1)).toBe(0);
    bb.storage.migrate(db, MIGRATIONS);
    expect(reconcileOpenSessions(db, 1)).toBe(0);
  });
});
