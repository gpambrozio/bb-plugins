// What the server tells the app about a thread's actions, and how a problem in the file reads.
// No SDK import and no parser, so the app may import it at run time.
import { z } from "zod";

/** Where the actions file lives, relative to the workspace root. */
export const ACTIONS_FILE = ".bb/actions.json";

/** Where the README explains the file; the empty state links to it. */
export const FORMAT_URL = "https://github.com/gpambrozio/bb-plugins/tree/main/project-actions#the-actions-file";

export const ActionSchema = z.object({
  name: z.string(),
  command: z.string(),
  /** Relative to the workspace root, normalised (`web/app`); null for the root itself. */
  cwd: z.string().nullable(),
  description: z.string().nullable(),
});
export type Action = z.infer<typeof ActionSchema>;

export const ProblemSchema = z.object({
  message: z.string(),
  /** 1-based; null when the problem is the whole file (too large, not text). */
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  /** The value's path in the file, as `actions[1].name`; null for a syntax error. */
  path: z.string().nullable(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/**
 * An action's last run in this thread: none (or its terminal is gone), still running, or finished
 * with its terminal still open on the result.
 */
export const RunStatusSchema = z.enum(["idle", "running", "finished"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ActionViewSchema = ActionSchema.extend({ status: RunStatusSchema });
export type ActionView = z.infer<typeof ActionViewSchema>;

export const ActionsListSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), actions: z.array(ActionViewSchema) }),
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("invalid"), problem: ProblemSchema }),
  /** No workspace to read, its machine is offline, or the read failed: `message` says which. */
  z.object({ state: z.literal("unavailable"), message: z.string() }),
]);
export type ActionsList = z.infer<typeof ActionsListSchema>;

export const RunOutcomeSchema = z.object({
  terminalId: z.string(),
  /** started: a new terminal; focused: the action was still running there; restarted: its last run had finished. */
  outcome: z.enum(["started", "focused", "restarted"]),
});
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** `.bb/actions.json, line 4, column 7 (actions[1].command)` */
export function describeLocation(problem: Problem): string {
  const parts = [ACTIONS_FILE];
  if (problem.line !== null) parts.push(`line ${problem.line}${problem.column === null ? "" : `, column ${problem.column}`}`);
  const where = parts.join(", ");
  return problem.path === null ? where : `${where} (${problem.path})`;
}
