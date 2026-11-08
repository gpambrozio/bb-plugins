/**
 * Upgrading a store from e54db75 (the build the owner first installed), whose Start race could leave
 * two open sessions for one source thread (review pass 2, finding 11), and from 0.1.0, whose caps
 * counted seen offers (PR #103 review pass 1, finding 2).
 */
import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "../server";
import { offerCaps } from "./policy";
import { readSettings } from "./settings";
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

const V0_2_0_HASHES = [
  "932906ce983caef1fbf3480a4288321764ef5ab9b97755fffcd0edc072ab4e95",
  "af55c76195c80512bda89328c3045f57e0148a4d82638cc75e655bbd01650048",
  "6b278ac6880d91bc5061c68dda786ce55a9d23f0dae8527834265bfd387af057",
  "052dafff193ec7fd67e9c122cdd9e55926642605387932bc5993216c8f80091c",
  "d5f150bec94417b626bd0316236f2e4a67149860c1179324462fb09a234767fb",
  "1d460cbba6193a28b4c29fc45606646c401eaf2f2e5a3488f042bfc06633ae15",
  "52b296b7a75a3e0cc3e2489432779981e1addd024fd57ce3131f97ff4c8e1475",
  "3aa935a349b1078a9f224a246500aad4d733555aa93b11e5b0a2e88902ac123e",
  "439cb7a9798ad88faa4a032890648875dc4358ce1eecb1beb6d6fc6344509b4e",
  "c76591abb425d1ee705490d6edb6c4f802d15c4ad9361badce89a66eec0e43af",
  "a1e093012ff7c797ce7081fc1c68b2578c50fe37ce1e1d8512678352b9d86b7c",
  "732841ff9dff60930335088ec67b89966e60e265250756551c6d8b974eaad3bf",
  "dd0b6b766144d1dd6dcd6c94cafcfadab2519b83fcb7cd6cfcedc9656f7f3bbd",
  "26bc96f48fc706443dc2f593c24c6d73169b922403014ce1bf281430f7d62e59",
  "390168484fc8078319dab8c0c81cb7aec8f4aea741da233c5da4ddb53cdb1bfc",
  "654658416c0451155573d5c58ce27b98edd2a92edd5bafe7936a7bfcaa950fe8",
  "990f14ed3027644679911114cf82e9bf6a0d39eedd20e4646bacd4790800752a",
  "b18275964018da443b8abd8cab42921b6f8999cb463a7a89e45867f62bfc819d",
  "4e8b97038cc6a20a88ef73946ff0ab96f983a2f002a1792f09d7167056c9ccd7",
  "b1ebe58fcd850b346f3de9d7ddb382cc4c4804d48c2c52afeee777a333ce7e85",
  "25f08393a3aaf56a73ddf2225d6fa993875b87e84abfb5fb6bc1cd52181d2656",
];
/**
 * 0.3.0's statements, after 0.2.0's 21: the orientation tables and indexes, the `sessions` rebuild for
 * mode `spawn` (R8/R9), and `orientations.verified_at`. Pinned before release like the rest: once a 0.3.0
 * store has recorded them, an edit would leave that store on different SQL than a fresh one.
 */
const V0_3_0_HASHES = [
  "b6445a740f7308cb2c2e8963e7459ef965ce04b7d73e017863e07271de6da0dd", // orientations
  "676bcaf883b55b9ee8c51f04ba33e2e570ff5f5ad88ad0b151c0b4f397da2a3d", // orientation_blocks
  "a97e6441a70d267728ba58392a82015a5c659dce296a3b5f6a29079a7a21864d", // orientations_one_live_per_project
  "db70f8d8d37fd7b439ee1f20d81205ede47fedbd15be180b71322a21fcd73d81", // orientations_builder
  "e0d873c699a4a149349917e299fb5ddda7616826f50d437887a2c5a00d192da2", // sessions_keep
  "a80bb6f8dce4f83146d7126d6a7d271202011850a664c238ea8cf193d1b0b26f", // exercises_keep
  "dafbde3e50c530df176c3ec9c1d1e29353c5ec7a45542b5c64d8770a8ed4c2fb", // DELETE FROM exercises
  "c8e2dedaad374c21f85a29a5be5b642ab81308287ef79bb95d0e20ac54244ef6", // DROP TABLE sessions
  "2fb9a734b48573d99bcc9c7c5da2eda0bf1d781652388304084b7b923283389e", // CREATE TABLE sessions (mode spawn)
  "052dafff193ec7fd67e9c122cdd9e55926642605387932bc5993216c8f80091c", // sessions_thread (as 0.2.0's)
  "d5f150bec94417b626bd0316236f2e4a67149860c1179324462fb09a234767fb", // sessions_source (as 0.2.0's)
  "1d460cbba6193a28b4c29fc45606646c401eaf2f2e5a3488f042bfc06633ae15", // sessions_project (as 0.2.0's)
  "c76591abb425d1ee705490d6edb6c4f802d15c4ad9361badce89a66eec0e43af", // sessions_one_open_per_source (as 0.2.0's)
  "f881e2b40423598425aeed0251484dbe38f1ab9711a33f496be22babd0608f9c", // INSERT INTO sessions
  "b7619fe664c8de4487148cd107c4cb674404895090a7619ccf641c1330236e5f", // INSERT INTO exercises
  "26403547082a9aeee2ede166072b185b748452400cb2722803a24d676ebff8da", // DROP TABLE sessions_keep
  "2f7df58714cb7aaee4f6b170778895192b41ced9a01e6274b6b0bd16c58f5a2c", // DROP TABLE exercises_keep
  "57778c47ae2ac356927f1906c783954e0813964c3490d3d9ac2bb97e8c4c8130", // orientations.verified_at
];
/** 0.2.0's last statement (the answered-offer seed); everything after it is newer. */
const SEED_INDEX = 20;

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

  it("keeps 0.2.0's 21 statements unchanged", () => {
    expect(MIGRATIONS.slice(0, 21).map(sha)).toEqual(V0_2_0_HASHES);
  });

  it("keeps 0.3.0's statements unchanged, and adds nothing unpinned after them", () => {
    expect(MIGRATIONS.slice(21).map(sha)).toEqual(V0_3_0_HASHES);
    expect(MIGRATIONS.at(-1)).toBe("ALTER TABLE orientations ADD COLUMN verified_at INTEGER");
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

describe("upgrading from 0.1.0: the answered-offer history", () => {
  const HOUR_MS = 3_600_000;
  const NOW = 100 * 24 * HOUR_MS;

  function v010Store() {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS.slice(0, SEED_INDEX)) db.exec(statement);
    const offer = db.prepare(
      `INSERT INTO offers (id, thread_id, project_key, trigger, topic, refs, status, answer, created_at, seen_at, answered_at) VALUES (?, ?, 'k', 'commit', 't', '{}', ?, ?, ?, ?, ?)`,
    );
    // Answered an hour ago, and a day and a half ago; one only seen, after the last answer; one never seen.
    offer.run("off_a", "thr_a", "answered", "later", NOW - 2 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS);
    offer.run("off_b", "thr_b", "answered", "start", NOW - 37 * HOUR_MS, NOW - 37 * HOUR_MS, NOW - 36 * HOUR_MS);
    offer.run("off_c", "thr_c", "expired", null, NOW - 40 * 60_000, NOW - 30 * 60_000, null);
    offer.run("off_d", "thr_d", "live", null, NOW - 10 * 60_000, null, null);
    // 0.1.0 counted what was seen.
    db.prepare(`INSERT INTO global_state (key, value) VALUES ('seenAt', ?)`).run(JSON.stringify([NOW - 37 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - 30 * 60_000]));
    return db;
  }

  it("seeds the answers once from the offers 0.1.0 answered, leaving out offers only seen", () => {
    const db = v010Store();
    db.exec(MIGRATIONS[SEED_INDEX]!);
    const store = new LearningStore(db);
    expect(store.global(NOW).answeredAt).toEqual([NOW - 36 * HOUR_MS, NOW - HOUR_MS]);
    // The caps read the answer's time: the gap runs from it, not from the later look.
    const caps = (now: number, offersPerDay: number) =>
      offerCaps({ now, settings: readSettings({ offersPerDay, hoursBetweenOffers: 2 }), trigger: "commit", finishedSessions: 0, global: store.global(now) });
    expect(caps(NOW, 1)).toBe("the daily limit is reached");
    expect(caps(NOW, 3)).toBe("too soon after the last offer");
    expect(caps(NOW + HOUR_MS, 3)).toBeNull();
    // An answer after the upgrade is added once.
    store.recordAnswered(NOW + HOUR_MS);
    expect(store.global(NOW + HOUR_MS).answeredAt).toEqual([NOW - 36 * HOUR_MS, NOW - HOUR_MS, NOW + HOUR_MS]);
  });

  it("never overwrites answers already kept, and a store with no answers starts empty", () => {
    const db = v010Store();
    db.prepare(`INSERT INTO global_state (key, value) VALUES ('answeredAt', ?)`).run(JSON.stringify([NOW - 5 * 60_000]));
    db.exec(MIGRATIONS[SEED_INDEX]!);
    expect(new LearningStore(db).global(NOW).answeredAt).toEqual([NOW - 5 * 60_000]);
    const empty = new Database(":memory:");
    for (const statement of MIGRATIONS) empty.exec(statement);
    expect(new LearningStore(empty).global(NOW).answeredAt).toEqual([]);
  });
});

describe("the orientation migration rebuilds sessions", () => {
  const FIRST = MIGRATIONS.indexOf("CREATE TABLE sessions_keep AS SELECT * FROM sessions");

  function seed(db: Db) {
    insertSession(db, "ses_a", "paused", 10);
    insertSession(db, "ses_done", "finished", 5);
    db.prepare(`UPDATE sessions SET source_thread_id = 'thr_other', summary = 'Covered it.', concepts = '["iterators"]', pause_reason = 'x', finished_at = 6 WHERE id = 'ses_done'`).run();
    answer(db, "ses_a", 1, "kept");
    db.prepare(
      `UPDATE exercises SET form = '{"f":1}', fields = '{"a":"b"}', reply = 'r', reply_progress = '{"p":1}', draft = 'd', draft_saved_at = 7, draft_writer = 'w', feedback = 'fb', feedback_turn = 'turn_1', skipped = 1, stuck = 1, verdict = 'got-it', gap = 'g'
       WHERE session_id = 'ses_a'`,
    ).run();
    answer(db, "ses_done", 1, "done");
  }

  const dump = (db: Db) => ({
    sessions: db.prepare(`SELECT * FROM sessions ORDER BY id`).all(),
    exercises: db.prepare(`SELECT * FROM exercises ORDER BY session_id, ordinal`).all(),
  });

  for (const foreignKeys of ["ON", "OFF"]) {
    it(`keeps every row and column, the indexes, and accepts mode spawn (foreign keys ${foreignKeys})`, () => {
      const { bb } = createFakePluginHost({ pluginId: "learning-exercises" });
      const db = bb.storage.database();
      db.pragma(`foreign_keys = ${foreignKeys}`);
      bb.storage.migrate(db, MIGRATIONS.slice(0, FIRST));
      seed(db);
      const before = dump(db);
      expect(before.exercises).toHaveLength(2);
      bb.storage.migrate(db, MIGRATIONS);
      expect(dump(db)).toEqual(before);
      const store = new LearningStore(db);
      expect(() => insertSession(db, "ses_b", "paused", 20)).toThrow(/UNIQUE/);
      db.prepare(`UPDATE sessions SET mode = 'spawn' WHERE id = 'ses_a'`).run();
      expect(store.session("ses_a")?.mode).toBe("spawn");
      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'sessions' AND type = 'index' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((row) => row.name).sort();
      expect(names).toEqual(["sessions_one_open_per_source", "sessions_project", "sessions_source", "sessions_thread"]);
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%_keep'`).all()).toEqual([]);
    });
  }
});
