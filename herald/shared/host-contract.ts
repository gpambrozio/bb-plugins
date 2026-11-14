/**
 * The contract between the server and the host entry (`host.ts`), which runs
 * on the machine whose bb desktop app speaks. The server sends the commands it
 * holds for that machine; the host never takes one from anywhere else. The
 * runs of speech are tracked there, on the machine, so the after hook is owed
 * by the machine and not by a window that may close (`host/sessions.ts`).
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HookRunSchema, RunIdSchema, SpeechHookCommandSchema } from "./speech-hooks";

const Lease = z.number().int().min(1_000).max(10 * 60_000);

export const hostContract = defineRpcContract({
  /**
   * Opens a run of speech. The first open run on this machine runs `before`
   * and keeps `after` for when the last one ends; a later one waits for that
   * `before` to finish. A run already ended (its `end` overtook this call) is
   * not opened.
   */
  begin: {
    input: z.object({ runId: RunIdSchema, before: SpeechHookCommandSchema, after: SpeechHookCommandSchema, leaseMs: Lease }),
    output: z.object({ open: z.boolean(), before: HookRunSchema.nullable() }),
  },
  /** Keeps a run open for another `leaseMs`; false when it is not open. */
  renew: {
    input: z.object({ runId: RunIdSchema, leaseMs: Lease }),
    output: z.object({ open: z.boolean() }),
  },
  /** Ends a run; safe to call twice, and before its `begin` arrives. The last open run's end runs `after`. */
  end: {
    input: z.object({ runId: RunIdSchema }),
    output: z.object({ after: HookRunSchema.nullable() }),
  },
});

export type HostContract = typeof hostContract;

export const hostSignals = {
  /**
   * The machine ended runs by itself and ran the after hook for them: a run's
   * lease ran out (its window went away), or the worker was shutting down.
   */
  afterWithoutWindow: {
    payload: z.object({ reason: z.enum(["expired", "disposed"]), runIds: z.array(z.string()), after: HookRunSchema.nullable() }),
  },
} satisfies ExperimentalHostSignals;
