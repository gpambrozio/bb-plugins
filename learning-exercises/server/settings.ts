/**
 * The plugin's settings, rendered by bb in Settings → Plugins → Learning Exercises. `readSettings`
 * turns bb's stored values into one typed object with every limit clamped, so a hand-edited value
 * cannot turn a cap off by accident.
 */
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";

/** Files that never count as new work worth an exercise (gitignore syntax, one per line). */
export const DEFAULT_EXCLUDE_PATTERNS = [
  "*.md",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "*.snap",
  "__snapshots__/",
  "*.generated.*",
  "*.min.js",
  "dist/",
  "build/",
  "vendor/",
  "node_modules/",
].join("\n");

/** Paths whose change counts as a schema or interface change (gitignore syntax, one per line). */
export const DEFAULT_SCHEMA_PATTERNS = ["migrations/", "*.sql", "schema.prisma", "*.proto", "*.graphql", "openapi.*"].join("\n");

/** Plugins whose top-level threads get no offers unless the user changes it: scheduled runs nobody is driving. */
export const DEFAULT_NO_OFFER_PLUGINS = "automations";

export const SETTINGS = {
  offersEnabled: {
    type: "boolean",
    label: "Offer exercises",
    description:
      "Offer a short exercise above a thread's composer after a commit, new files, a schema change or a merged pull request. Turn it off to start sessions only from the Learning tab.",
    default: true,
  },
  noOfferPlugins: {
    type: "string",
    label: "Plugins whose threads get no offers",
    description:
      "Threads another plugin starts at the top level get offers like your own (a GitHub board card's thread, say), except those of the plugins listed here: one plugin id per line. Learning Exercises' own session threads never get offers, whatever this says. Threads a plugin starts as a child of another thread never get offers either.",
    experimental_multiline: true,
    default: DEFAULT_NO_OFFER_PLUGINS,
  },
  triggerCommit: { type: "boolean", label: "After a commit", description: "Offer when a turn made a commit.", default: true },
  triggerNewFiles: { type: "boolean", label: "After new files", description: "Offer when a turn added source files.", default: true },
  triggerSchema: {
    type: "boolean",
    label: "After a schema change",
    description: "Offer when a turn changed a path that matches the schema patterns below.",
    default: true,
  },
  triggerPrMerged: {
    type: "boolean",
    label: "After a pull request merges",
    description: "Offer when the thread's pull request is merged (read from bb's GitHub PR Status).",
    default: true,
  },
  triggerStreak: {
    type: "boolean",
    label: "After a working streak",
    description: "Offer after several turns in a row that changed files.",
    default: false,
  },
  streakTurns: { type: "number", label: "Turns in a streak", description: "Turns with file changes since the last offer (2–50).", default: 8 },
  sessionsPerThread: {
    type: "number",
    label: "Sessions per thread",
    description: "Stop offering in a thread after this many finished sessions (1–10). You can still start one from the Learning tab.",
    default: 2,
  },
  offersPerDay: { type: "number", label: "Offers per day", description: "The most offers you answer in 24 hours, across threads (1–20). An offer you leave unanswered does not count.", default: 3 },
  hoursBetweenOffers: {
    type: "number",
    label: "Hours between offers",
    description: "After you answer an offer, the least time before the next one shows, across threads (0–24). An offer you leave unanswered does not count.",
    default: 2,
  },
  questionsPerSession: {
    type: "number",
    label: "Questions per session",
    description: "The most questions one session asks (2–20). The agent wraps up at the limit.",
    default: 8,
  },
  sessionLocation: {
    type: "select",
    label: "Where a session runs",
    description:
      "A side thread forked from the work (the work thread is left alone), or the work thread itself. A provider that cannot fork always runs it in the work thread.",
    options: ["fork", "here"],
    experimental_optionLabels: { fork: "A side thread", here: "The work thread" },
    default: "fork",
  },
  learnerProfile: {
    type: "string",
    label: "About you",
    description: "Your experience and what you want to get better at. Every session reads it, so the questions fit you.",
    experimental_multiline: true,
    default: "",
  },
  excludePatterns: {
    type: "string",
    label: "Files that are not new work",
    description: "New files matching these never prompt an offer: lockfiles, generated or vendored code, snapshots, docs. One gitignore pattern per line.",
    experimental_multiline: true,
    default: DEFAULT_EXCLUDE_PATTERNS,
  },
  schemaPatterns: {
    type: "string",
    label: "Schema and interface files",
    description: "A change to a path matching these is a schema change. One gitignore pattern per line.",
    experimental_multiline: true,
    default: DEFAULT_SCHEMA_PATTERNS,
  },
} satisfies PluginSettingDescriptors;

export interface LearningSettings {
  offersEnabled: boolean;
  /** Plugin ids whose top-level threads get no offers (`isHumanThread`); this plugin is kept out on top. */
  noOfferPlugins: string[];
  triggers: { commit: boolean; newFiles: boolean; schema: boolean; prMerged: boolean; streak: boolean };
  streakTurns: number;
  sessionsPerThread: number;
  offersPerDay: number;
  hoursBetweenOffers: number;
  questionsPerSession: number;
  sessionLocation: "fork" | "here";
  learnerProfile: string;
  excludePatterns: string;
  schemaPatterns: string;
}

type Raw = Record<string, unknown>;

function bool(raw: Raw, key: keyof typeof SETTINGS): boolean {
  const value = raw[key];
  const fallback = SETTINGS[key].default;
  return typeof value === "boolean" ? value : (fallback as boolean);
}

function int(raw: Raw, key: keyof typeof SETTINGS, min: number, max: number): number {
  const value = raw[key];
  const fallback = SETTINGS[key].default as number;
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function text(raw: Raw, key: keyof typeof SETTINGS): string {
  const value = raw[key];
  return typeof value === "string" ? value : (SETTINGS[key].default as string);
}

/** Plugin ids, one per line (commas and spaces separate them too), trimmed, without repeats. */
export function pluginIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter((id) => id !== ""))];
}

export function readSettings(values: object): LearningSettings {
  const raw = values as Raw;
  return {
    offersEnabled: bool(raw, "offersEnabled"),
    noOfferPlugins: pluginIds(text(raw, "noOfferPlugins")),
    triggers: {
      commit: bool(raw, "triggerCommit"),
      newFiles: bool(raw, "triggerNewFiles"),
      schema: bool(raw, "triggerSchema"),
      prMerged: bool(raw, "triggerPrMerged"),
      streak: bool(raw, "triggerStreak"),
    },
    streakTurns: int(raw, "streakTurns", 2, 50),
    sessionsPerThread: int(raw, "sessionsPerThread", 1, 10),
    offersPerDay: int(raw, "offersPerDay", 1, 20),
    hoursBetweenOffers: int(raw, "hoursBetweenOffers", 0, 24),
    questionsPerSession: int(raw, "questionsPerSession", 2, 20),
    sessionLocation: raw.sessionLocation === "here" ? "here" : "fork",
    learnerProfile: text(raw, "learnerProfile").slice(0, 2000),
    excludePatterns: text(raw, "excludePatterns"),
    schemaPatterns: text(raw, "schemaPatterns"),
  };
}
