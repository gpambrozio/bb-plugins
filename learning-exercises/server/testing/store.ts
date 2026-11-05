/** A `LearningStore` over an in-memory SQLite with every migration applied, as bb would. */
import Database from "better-sqlite3";

import { readSettings, type LearningSettings } from "../settings";
import { LearningStore, MIGRATIONS } from "../store";

export function memoryStore(): LearningStore {
  return memoryStoreWithDb().store;
}

/** An in-memory store and its database, for a test that checks a stored value as it is. */
export function memoryStoreWithDb(): { store: LearningStore; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const statement of MIGRATIONS) db.exec(statement);
  return { store: new LearningStore(db), db };
}

/** The default settings with `overrides` (in their stored, flat shape). */
export function settingsWith(overrides: Record<string, unknown> = {}): LearningSettings {
  return readSettings(overrides);
}
