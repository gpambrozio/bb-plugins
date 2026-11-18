/**
 * What the app and the server exchange, as zod shapes with no SDK import (the app uses them at run
 * time), and the realtime channel the server announces changes on.
 */
import { z } from "zod";

import { ChangesSchema, ModeSchema, ProjectStatusSchema } from "./types";

export const DREAM_CHANGED = "dream-changed";

export const DEFAULT_PROVIDER = "claude-code";
/**
 * The most capable Claude model bb's Claude Code provider offers (bb 0.49 lists Fable 5.2 as "For your
 * toughest challenges", above Opus 5.5), at high reasoning. A setting: users change it in the plugin's
 * settings section.
 */
export const DEFAULT_MODEL = "claude-fable-5-2";
export const DEFAULT_REASONING = "high";

/** Choices the host-rendered form cannot offer: the machine and the model, set from the plugin's settings section. */
export const ChoicesSchema = z.object({
  /** Null means the machine running the bb server. */
  hostId: z.string().nullable(),
  model: z.string().min(1),
  reasoningLevel: z.string().min(1),
});
export type Choices = z.infer<typeof ChoicesSchema>;

export const DEFAULT_CHOICES: Choices = { hostId: null, model: DEFAULT_MODEL, reasoningLevel: DEFAULT_REASONING };

export const OutcomeSchema = z.enum(["running", "changed", "unchanged", "proposed", "failed"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  hostId: z.string(),
  mode: ModeSchema,
  trigger: z.enum(["schedule", "manual"]),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: OutcomeSchema,
  threadId: z.string().nullable(),
  changes: ChangesSchema.nullable(),
  summary: z.string().nullable(),
  backup: z.string().nullable(),
  proposal: z.string().nullable(),
  error: z.string().nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ScheduleSchema = z.object({
  enabled: z.boolean(),
  windowStart: z.string(),
  windowEnd: z.string(),
  inWindow: z.boolean(),
  /** When the window next opens, or closes while it is open; null for an empty window. */
  nextChange: z.number().nullable(),
  lastSweepAt: z.number().nullable(),
});

export const OverviewSchema = z.object({
  host: z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).nullable(),
  hosts: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })),
  choices: ChoicesSchema,
  schedule: ScheduleSchema,
  projects: z.array(ProjectStatusSchema),
  active: RunRecordSchema.nullable(),
  /** Why the projects could not be read, such as the dream machine being offline. */
  error: z.string().nullable(),
});
export type Overview = z.infer<typeof OverviewSchema>;
