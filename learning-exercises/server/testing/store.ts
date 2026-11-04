/** A `LearningStore` over an in-memory SQLite with every migration applied, as bb would. */
import Database from "better-sqlite3";

import { readSettings, type LearningSettings } from "../settings";
import { LearningStore, MIGRATIONS } from "../store";

export function memoryStore(): LearningStore {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new LearningStore(db);
}

/** The default settings with `overrides` (in their stored, flat shape). */
export function settingsWith(overrides: Record<string, unknown> = {}): LearningSettings {
  return readSettings(overrides);
}
