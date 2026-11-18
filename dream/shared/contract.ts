/**
 * The app ⇄ server RPC contract. The app imports it as a type only (it pulls in the SDK root,
 * which the app bundle must not load at run time).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { ChoicesSchema, OverviewSchema, RunRecordSchema } from "./contract-types";
import { ApplyResultSchema, BackupListSchema, ModeSchema, ProposalDiffSchema, RestoreResultSchema } from "./types";

const ByProject = z.object({ projectId: z.string().min(1) });
const Started = z.object({ runId: z.string(), threadId: z.string(), mode: ModeSchema, projectName: z.string() });

export const rpcContract = defineRpcContract({
  overview: { input: z.object({}), output: OverviewSchema },
  history: { input: z.object({ limit: z.number().int().min(1).max(300).optional(), projectId: z.string().optional() }), output: z.array(RunRecordSchema) },
  setSwitch: { input: ByProject.extend({ enabled: z.boolean() }), output: z.object({}) },
  setChoices: { input: ChoicesSchema.partial(), output: ChoicesSchema },
  run: { input: ByProject.extend({ dryRun: z.boolean() }), output: Started },
  stop: { input: z.object({}), output: z.object({ stopped: z.boolean() }) },
  apply: { input: ByProject.extend({ stamp: z.string().optional() }), output: ApplyResultSchema },
  discard: { input: ByProject.extend({ stamp: z.string().optional() }), output: z.object({ stamp: z.string() }) },
  restore: { input: ByProject.extend({ stamp: z.string().optional() }), output: RestoreResultSchema },
  backups: { input: ByProject, output: BackupListSchema },
  /** A waiting dry run's changes, file by file, against the memory now. Reads only. */
  proposal: { input: ByProject.extend({ stamp: z.string().optional() }), output: ProposalDiffSchema },
});

export type RpcContract = typeof rpcContract;
