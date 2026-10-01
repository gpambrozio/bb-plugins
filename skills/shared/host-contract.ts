/**
 * The contract between the server entry and the host entry (`host.ts`), which
 * runs on the machine holding the thread's environment and reads that
 * machine's files: the checkout or worktree, and the provider homes under the
 * user's home directory.
 *
 * The server fills every field from the thread itself — the app never names a
 * provider, a directory or a path.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { SkillDocumentSchema, SkillEntrySchema } from "./skills";

const Workspace = { provider: z.string().min(1), cwd: z.string().min(1) };

export const hostContract = defineRpcContract({
  discover: {
    input: z.object(Workspace),
    output: z.object({ scanned: z.boolean(), skills: z.array(SkillEntrySchema) }),
  },
  /** Re-runs discovery and reads the entry whose id it produced. */
  read: {
    input: z.object({ ...Workspace, skillId: z.string().min(1) }),
    output: SkillDocumentSchema,
  },
});

export type HostContract = typeof hostContract;
