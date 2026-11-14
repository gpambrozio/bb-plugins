/**
 * The contract between the server and the host entry (`host.ts`), which runs
 * on the machine whose bb desktop app speaks. The server sends the command it
 * holds for that machine; the host never takes one from anywhere else.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HookRunSchema, SpeechHookCommandSchema, SpeechHookKindSchema } from "./speech-hooks";

export const hostContract = defineRpcContract({
  /** Runs one hook through the machine's shell, from its home folder, and waits for it, up to the timeout. */
  runHook: {
    input: z.object({ kind: SpeechHookKindSchema, command: SpeechHookCommandSchema.min(1) }),
    output: HookRunSchema,
  },
});

export type HostContract = typeof hostContract;
