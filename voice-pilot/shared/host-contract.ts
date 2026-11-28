/**
 * The contract between the server and the host entry (`host.ts`), which runs on the machine whose bb desktop
 * app holds the call, or whose hook the settings' editor opened. No method takes a path: the host runs, reads
 * and writes only its own machine's hook file in `~/.config/voice-pilot/`, by one of `HOOK_NAMES`.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HookEventSchema, HookFileReadSchema, HookFileStatusSchema, HookRunSchema, HookWriteResultSchema, HookWriteSchema } from "./hooks";

export const hostContract = defineRpcContract({
  /** Whether this machine has a hook file, and whether it can be run. Never its contents. */
  status: { input: z.object({}).strict(), output: HookFileStatusSchema },
  /** Runs this machine's hook file once for `event`; null when there is no hook file. */
  run: {
    input: z.object({ event: HookEventSchema, reason: z.string().max(200).nullable() }).strict(),
    output: HookRunSchema.nullable(),
  },
  /** The settings' hook editor: this machine's hook file as text, to edit. */
  read: { input: z.object({}).strict(), output: HookFileReadSchema },
  /** Saves this machine's hook file by its name (one of `HOOK_NAMES`, never a path), unless it changed on disk. */
  write: { input: HookWriteSchema, output: HookWriteResultSchema },
});

export type HostContract = typeof hostContract;
