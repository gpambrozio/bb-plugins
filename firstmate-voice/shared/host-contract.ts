/**
 * The contract between the server and the host entry (`host.ts`), which runs on the machine whose bb desktop
 * app holds the call. The server sends the command it holds for that machine; the host never takes one from
 * anywhere else.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HookCommandSchema, HookEventSchema, HookRunSchema } from "./hooks";

export const hostContract = defineRpcContract({
  /** Runs the command once for `event`, and answers how it went once it has exited or been stopped. */
  run: {
    input: z.object({ command: HookCommandSchema.min(1), event: HookEventSchema, reason: z.string().max(200).nullable() }),
    output: HookRunSchema,
  },
});

export type HostContract = typeof hostContract;
