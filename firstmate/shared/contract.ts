/**
 * The RPCs between the app and the server. The app imports the contract as a type
 * (`useRpc<typeof rpcContract>()`), the server registers handlers for it (`server.ts`).
 *
 * Methods that take nothing take `{}`; methods that answer nothing answer `null`. A refusal is the
 * handler's own sentence, which the panel shows as-is.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { FleetSchema, SuggestionSchema, WatchSummarySchema } from "./types";

const Empty = z.object({});
const Done = z.null();
const ThreadRef = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  "fleet.load": { input: Empty, output: FleetSchema },
  "mate.launch": {
    input: z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string().optional() }),
    output: ThreadRef,
  },
  "mate.adopt": { input: ThreadRef, output: Done },
  "mate.release": { input: Empty, output: Done },
  "mate.restart": { input: Empty, output: Done },
  "mate.command": { input: z.object({ command: z.enum(["bearings", "ahoy"]), args: z.string() }), output: Done },
  "mate.ask": { input: z.object({ text: z.string().min(1) }), output: Done },
  "crew.steer": { input: ThreadRef.extend({ text: z.string().min(1) }), output: Done },
  "crew.interrupt": { input: ThreadRef, output: Done },
  "crew.end": {
    input: ThreadRef.extend({ confirmed: z.boolean() }),
    output: z.object({ ended: z.boolean(), needsConfirmation: z.boolean() }),
  },
  "crew.relaunch": { input: ThreadRef.extend({ note: z.string() }), output: Done },
  "crew.note": { input: ThreadRef.extend({ note: z.string() }), output: Done },
  "suggestion.remove": { input: SuggestionSchema, output: z.array(SuggestionSchema) },
  "charter.compare": { input: Empty, output: z.object({ path: z.string() }) },
  "charter.acknowledge": { input: Empty, output: Done },
  "watch.toggle": { input: z.object({ name: z.string().min(1), enabled: z.boolean() }), output: z.array(WatchSummarySchema) },
});
