/**
 * What the server pushes to the app, and the shapes it pushes. No SDK import,
 * so the app can parse these at run time.
 */
import { z } from "zod";

/** Published with a `Health` whenever the server re-counts failing jobs. */
export const HEALTH_CHANGED = "health-changed";
/** Published with a `LogChanged` when a followed job's log changes. */
export const LOG_CHANGED = "log-changed";

export const FailingEntrySchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  id: z.string(),
  name: z.string(),
});

export type FailingEntry = z.infer<typeof FailingEntrySchema>;

export const HealthSchema = z.object({
  /** Jobs whose latest run failed and whose failure has not been seen, on every Mac checked. */
  failing: z.array(FailingEntrySchema),
  /** When the count was taken, or null before the first one. */
  checkedAt: z.number().nullable(),
});

export type Health = z.infer<typeof HealthSchema>;

export const LogChangedSchema = z.object({ hostId: z.string(), id: z.string() });

export type LogChanged = z.infer<typeof LogChangedSchema>;

export const HostChoiceSchema = z.object({ id: z.string(), name: z.string() });

export type HostChoice = z.infer<typeof HostChoiceSchema>;
