/**
 * The contract between the server entry and the host entry (`host.ts`), which
 * runs on the Mac whose jobs are being managed. Each method acts on that
 * machine's `~/Library/LaunchAgents`, its launchd and its files.
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { FailingJobSchema, JobListSchema, JobSchema, JobSpecSchema, LogChunkSchema } from "./jobs";

const ById = z.object({ id: z.string().min(1) });
const Empty = z.object({});

export const hostContract = defineRpcContract({
  list: { input: Empty, output: JobListSchema },
  create: { input: JobSpecSchema, output: JobSchema },
  update: { input: z.object({ id: z.string().min(1), spec: JobSpecSchema }), output: JobSchema },
  delete: { input: ById, output: Empty },
  run: { input: ById, output: Empty },
  setEnabled: { input: z.object({ id: z.string().min(1), enabled: z.boolean() }), output: JobSchema },
  log: {
    input: z.object({ id: z.string().min(1), from: z.number().int().min(0).optional() }),
    output: LogChunkSchema,
  },
  /**
   * Starts watching the job's log, or extends a watch already running. The
   * watch ends by itself `expiresInMs` after the last call, so a window that
   * closes without saying so leaves nothing behind.
   */
  follow: { input: ById, output: z.object({ expiresInMs: z.number().int().positive() }) },
  unfollow: { input: ById, output: Empty },
  /** No `launchctl`: the plists and the last line of each history file. */
  health: {
    input: Empty,
    output: z.object({ supported: z.boolean(), jobCount: z.number().int().min(0), failing: z.array(FailingJobSchema) }),
  },
  acknowledge: { input: ById, output: Empty },
});

export type HostContract = typeof hostContract;

export const hostSignals = {
  /** A followed job's log changed. */
  logChanged: { payload: z.object({ id: z.string() }) },
} satisfies ExperimentalHostSignals;
