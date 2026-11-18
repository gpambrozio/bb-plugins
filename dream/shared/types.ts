/**
 * The shapes the host, the server and the app exchange. No SDK import, so the app may use these at
 * run time.
 */
import { z } from "zod";

import { GATE_CODES, ThresholdsSchema } from "./gate";

export const ChangesSchema = z.object({ added: z.array(z.string()), changed: z.array(z.string()), deleted: z.array(z.string()) });
export type Changes = z.infer<typeof ChangesSchema>;

export const ModeSchema = z.enum(["dream", "dry-run"]);
export type Mode = z.infer<typeof ModeSchema>;

/** A project as the server hands it to the host: its checkout there and its transcript folders. */
export const ProjectInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string(),
  checkout: z.string().min(1),
  enabled: z.boolean(),
  /** bb worktree transcript folders that belong to this project. */
  worktreeFolders: z.array(z.string()),
});
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

export const WorktreeFolderSchema = z.object({ name: z.string(), threadId: z.string(), repoSlug: z.string() });

export const MemoryInfoSchema = z.object({
  dir: z.string(),
  source: z.enum(["env", "policySettings", "localSettings", "projectSettings", "userSettings", "default"]),
  configured: z.string().nullable(),
  defaultDir: z.string(),
  autoMemoryEnabled: z.boolean(),
  warnings: z.array(z.string()),
  files: z.number().int(),
  indexLines: z.number().int().nullable(),
  indexBytes: z.number().int().nullable(),
});
export type MemoryInfo = z.infer<typeof MemoryInfoSchema>;

export const GateSummarySchema = z.object({
  due: z.boolean(),
  code: z.enum(GATE_CODES),
  reason: z.string(),
  lastDreamAt: z.number().nullable(),
  baselineAt: z.number().nullable(),
  sessionsSince: z.number().int(),
  daysSince: z.number().int(),
});
export type GateSummary = z.infer<typeof GateSummarySchema>;

export const ProposalSummarySchema = z.object({
  stamp: z.string(),
  createdAt: z.number(),
  status: z.enum(["running", "ready", "applied", "discarded", "failed"]),
  changes: ChangesSchema.nullable(),
  dir: z.string(),
});

export const ProjectStatusSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  checkout: z.string(),
  enabled: z.boolean(),
  memory: MemoryInfoSchema,
  gate: GateSummarySchema,
  folders: z.number().int(),
  sessions: z.number().int(),
  inPlace: z.boolean(),
  pendingProposal: ProposalSummarySchema.nullable(),
  lastBackup: z.string().nullable(),
});
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ManifestEntrySchema = z.object({ path: z.string(), date: z.string(), title: z.string().nullable(), size: z.number() });
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const PreparedSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    mode: ModeSchema,
    workspace: z.string(),
    /** Where the dream writes: the memory folder, or a dry run's copy of it. */
    targetDir: z.string(),
    memoryDir: z.string(),
    checkout: z.string(),
    transcriptFolders: z.array(z.string()),
    sessions: z.array(ManifestEntrySchema),
    sessionCount: z.number().int(),
    instructionFiles: z.array(z.string()),
    backup: z.string().nullable(),
    proposal: z.string().nullable(),
    /** The file the startup check asks the thread to Write; the hooks must keep it from existing. */
    canary: z.string(),
  }),
  z.object({ ok: z.literal(false), code: z.enum([...GATE_CODES, "no-guard", "no-workspace"]), reason: z.string() }),
]);
export type Prepared = z.infer<typeof PreparedSchema>;

export const FinishedSchema = z.object({
  /** False when the host knows nothing of the run (never prepared, or its state was lost). */
  found: z.boolean(),
  mode: ModeSchema,
  changes: ChangesSchema,
  backup: z.string().nullable(),
  proposal: z.string().nullable(),
  proposalDir: z.string().nullable(),
  /** Something went wrong that the run's log should say, such as a lock that could not be rolled back. */
  warning: z.string().nullable(),
});
export type Finished = z.infer<typeof FinishedSchema>;

export const BackupListSchema = z.object({
  backups: z.array(z.object({ stamp: z.string(), size: z.number() })),
  proposals: z.array(ProposalSummarySchema),
});

export const ApplyResultSchema = z.object({ stamp: z.string(), changes: ChangesSchema, backup: z.string() });
export const RestoreResultSchema = z.object({ stamp: z.string(), changes: ChangesSchema, backup: z.string() });

export { ThresholdsSchema };
