/**
 * The contract between the server entry and the host entry (`host.ts`), which runs on the dream
 * machine: every read of `~/.claude` and every write of memory, backups and proposals happens there.
 * The app imports nothing from here.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  ApplyResultSchema,
  BackupListSchema,
  FinishedSchema,
  ModeSchema,
  PreparedSchema,
  ProposalDiffSchema,
  ProjectInputSchema,
  ProjectStatusSchema,
  RestoreResultSchema,
  ThresholdsSchema,
  WorktreeFolderSchema,
} from "./types";

const ByProject = z.object({ project: ProjectInputSchema, stamp: z.string().optional() });

export const hostContract = defineRpcContract({
  /** The transcript folders that are bb worktrees, for the server to map to projects. */
  scan: {
    input: z.object({}),
    output: z.object({ projectsDir: z.string(), platform: z.string(), worktreeFolders: z.array(WorktreeFolderSchema) }),
  },
  status: {
    input: z.object({ projects: z.array(ProjectInputSchema), thresholds: ThresholdsSchema }),
    output: z.object({ projects: z.array(ProjectStatusSchema) }),
  },
  /**
   * Takes the lock, backs up (a dream) or copies (a dry run), and writes the workspace. `mode: null`
   * picks a dry run until the project's first proposal has been applied. `manual` skips the time,
   * session and busy gates; it never skips the lock.
   */
  prepare: {
    input: z.object({
      runId: z.string().min(1),
      project: ProjectInputSchema,
      mode: ModeSchema.nullable(),
      manual: z.boolean(),
      thresholds: ThresholdsSchema,
      backupsToKeep: z.number().int().min(1),
    }),
    output: PreparedSchema,
  },
  /** Ends a prepared run: records its changes, or rolls the lock back when it failed. */
  finish: {
    input: z.object({ runId: z.string().min(1), ok: z.boolean(), summary: z.string().nullable(), threadId: z.string().nullable() }),
    output: FinishedSchema,
  },
  /** The startup check: did the guard run, and does this Claude Code honour onFailure "block"? */
  checkCanary: { input: z.object({ runId: z.string().min(1) }), output: z.object({ ok: z.boolean(), reason: z.string() }) },
  apply: { input: ByProject.extend({ backupsToKeep: z.number().int().min(1) }), output: ApplyResultSchema },
  discard: { input: ByProject, output: z.object({ stamp: z.string() }) },
  restore: { input: ByProject.extend({ backupsToKeep: z.number().int().min(1) }), output: RestoreResultSchema },
  backups: { input: z.object({ project: ProjectInputSchema }), output: BackupListSchema },
  /** A waiting dry run's changes, file by file, for the proposal view. Reads only. */
  proposalDiff: { input: ByProject, output: ProposalDiffSchema },
  /** The runs this host still holds a lock for, so a reloaded server can finish them. */
  activeRuns: {
    input: z.object({}),
    output: z.object({ runs: z.array(z.object({ runId: z.string(), projectId: z.string(), startedAt: z.number() })) }),
  },
});

export type HostContract = typeof hostContract;
