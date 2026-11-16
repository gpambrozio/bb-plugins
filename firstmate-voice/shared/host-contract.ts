/**
 * The contract between the server and the host entry (`host.ts`), which runs on the machine whose bb desktop
 * app holds the call. Neither method takes a command or a path: the host runs only its own machine's hook
 * file (`HOOK_FILE`), and says of it only whether it is there.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HookEventSchema, HookFileStatusSchema, HookRunSchema } from "./hooks";

export const hostContract = defineRpcContract({
  /** Whether this machine has a hook file, and whether it can be run. Never its contents. */
  status: { input: z.object({}).strict(), output: HookFileStatusSchema },
  /** Runs this machine's hook file once for `event`; null when there is no hook file. */
  run: {
    input: z.object({ event: HookEventSchema, reason: z.string().max(200).nullable() }).strict(),
    output: HookRunSchema.nullable(),
  },
});

export type HostContract = typeof hostContract;
