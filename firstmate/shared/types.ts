/**
 * The vocabulary the board, the server and the first mate's charter share: the metadata a crewmate
 * thread is created with, the words it ends a turn with, and the shapes of the board's data.
 *
 * The plugin never dispatches a crewmate itself. The first mate does, with bb's own tools; the plugin
 * sets up its home, starts it, carries the captain's words to it, and draws what it and its crew are doing.
 */
import { z } from "zod";

/**
 * The keys a crewmate thread is created with, inside the plugin's own metadata namespace. The charter
 * tells the first mate to set them, and the board finds the crew by them, so both read this one object
 * rather than spelling the keys twice.
 */
export const CREW_METADATA = {
  role: "role",
  crewRole: "crew",
  mateRole: "first-mate",
  task: "task",
  kind: "kind",
  project: "project",
} as const;

/** The words a crewmate ends every turn with: `<state>: <one short line>`. */
export const CrewStateSchema = z.enum([
  "working",
  "needs-decision",
  "blocked",
  "paused",
  "done",
  "failed",
  "resolved",
]);
export type CrewState = z.infer<typeof CrewStateSchema>;

export const COLUMN_IDS = ["queued", "working", "blocked", "parked", "done", "failed", "idle"] as const;
export const ColumnIdSchema = z.enum(COLUMN_IDS);
export type ColumnId = z.infer<typeof ColumnIdSchema>;

export const ThreadStatusSchema = z.enum(["pending", "idle", "starting", "active", "stopping", "error"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const CrewReportSchema = z.object({
  state: CrewStateSchema,
  text: z.string(),
});
export type CrewReport = z.infer<typeof CrewReportSchema>;

export const BacklogSectionSchema = z.enum(["in-flight", "queued", "done"]);
export type BacklogSection = z.infer<typeof BacklogSectionSchema>;

export const BacklogItemSchema = z.object({
  section: BacklogSectionSchema,
  id: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  kind: z.string().nullable(),
  mode: z.string().nullable(),
  threadId: z.string().nullable(),
  hold: z.string().nullable(),
  blockedBy: z.string().nullable(),
  since: z.string().nullable(),
  url: z.string().nullable(),
  reportPath: z.string().nullable(),
  outcome: z.string().nullable(),
});
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

/** What the board needs of one bb thread — a crewmate. */
export const CrewSummarySchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  status: ThreadStatusSchema,
  pendingInteractions: z.number().int(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  updatedAt: z.number(),
  task: z.string().nullable(),
  kind: z.string().nullable(),
  project: z.string().nullable(),
});
export type CrewSummary = z.infer<typeof CrewSummarySchema>;

/**
 * One card on the board: a backlog item, a crewmate, or — the usual case once work is under way — both,
 * joined by task id.
 */
export const FleetCardSchema = z.object({
  key: z.string(),
  column: ColumnIdSchema,
  taskId: z.string().nullable(),
  title: z.string(),
  project: z.string().nullable(),
  kind: z.string().nullable(),
  backlog: BacklogItemSchema.nullable(),
  crew: CrewSummarySchema.nullable(),
  /** The status line the crewmate ended its last turn with. */
  report: CrewReportSchema.nullable(),
  /** A pull request, from the report or the backlog line. */
  url: z.string().nullable(),
});
export type FleetCard = z.infer<typeof FleetCardSchema>;

export const ProjectSchema = z.object({
  name: z.string(),
  mode: z.string().nullable(),
  yolo: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A next step the first mate suggests, from `data/suggestions.md`: a button's label and what pressing it
 * puts in the composer.
 */
export const SuggestionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

/** The home's folder of watch scripts, relative to the home. */
export const WATCHES_DIR = "watches";

/** The plugin's own folder in the home, for what the plugin keeps there rather than the first mate. */
export const STATE_DIR = ".firstmate";

/**
 * What a watch's last run came to: `silent` printed nothing; `queued` printed something that waits for
 * the first mate to be idle; `delivered` printed something the first mate has been sent; `dropped`
 * printed something a full queue pushed out before it could be sent; `failed` exited non-zero or ran out
 * of time; `invalid` cannot run at all; `never` has not run since it appeared.
 */
export const WatchResultSchema = z.enum(["never", "silent", "queued", "delivered", "dropped", "failed", "invalid"]);
export type WatchResult = z.infer<typeof WatchResultSchema>;

/**
 * One script in the home's `watches/` folder, as the board's Watches card shows it. The runner runs it on
 * its schedule and sends the first mate whatever it prints.
 */
export const WatchSummarySchema = z.object({
  /** Its file name in `watches/`. */
  name: z.string(),
  /** The schedule as its header writes it, or null when it has none. */
  schedule: z.string().nullable(),
  /** False once the captain has switched it off on the card. */
  enabled: z.boolean(),
  /** Why it cannot run — no schedule, a bad one, not executable — or null when it can. */
  invalid: z.string().nullable(),
  running: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastResult: WatchResultSchema,
  /** What it last printed, clipped, and when; kept while later runs are silent. */
  lastOutput: z.string().nullable(),
  lastOutputAt: z.string().nullable(),
  /** Why its last run failed, with the end of what it wrote to stderr. */
  lastError: z.string().nullable(),
  /** One of the plugin's own watches. */
  builtIn: z.boolean(),
  /** A built-in the captain has edited, whose plugin version has changed since. */
  outdated: z.boolean(),
});
export type WatchSummary = z.infer<typeof WatchSummarySchema>;

/** The state of the captain's copy of the charter, `data/charter.md`, against the plugin's own. */
export const CharterStateSchema = z.object({
  /** What `AGENTS.md` is rendered from: the captain's copy, or the plugin's charter. */
  template: z.string(),
  /** The captain has edited their copy. */
  edited: z.boolean(),
  /** The captain has edited their copy, and the plugin's charter has changed since it started from it. */
  outdated: z.boolean(),
});
export type CharterState = z.infer<typeof CharterStateSchema>;

export const FleetSchema = z.object({
  home: z.string(),
  /** False until the first launch has written the charter and records. */
  homeReady: z.boolean(),
  mate: z
    .object({
      threadId: z.string(),
      status: ThreadStatusSchema,
      title: z.string().nullable(),
    })
    .nullable(),
  /** A first mate is recorded but bb no longer has its thread (archived, deleted). */
  mateMissing: z.boolean(),
  cards: z.array(FleetCardSchema),
  /** What the captain might do next, most likely first; empty hides the card and the tab. */
  suggestions: z.array(SuggestionSchema),
  charter: CharterStateSchema,
  /** The home's watch scripts, by name; empty hides the card. */
  watches: z.array(WatchSummarySchema),
});
export type Fleet = z.infer<typeof FleetSchema>;
