/**
 * The RPCs between the app and the server. The server registers handlers for it (`server.ts`); the app
 * calls through `useRpc<typeof rpcContract>()` and reads the fleet with `experimental_useRpcQuery`, which
 * takes the contract as a value. So this module must not import the SDK at run time: bb provides the SDK
 * root to the server bundle only, and a git install builds the app without it. `defineRpcContract` only
 * returns its argument; `satisfies` gives the same checks.
 *
 * Methods that take nothing take `{}`; methods that answer nothing answer `null`. A refusal is the
 * handler's own sentence, which the panel shows as-is.
 */
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { FleetSchema, SuggestionSchema, WatchNoteSchema, WatchSummarySchema } from "./types";

const Empty = z.object({});
const Done = z.null();
const ThreadRef = z.object({ threadId: z.string().min(1) });

/** The tag `fleet.load` reads carry; invalidating it makes every open board read the fleet again. */
export const FLEET_TAG = "fleet";

export const rpcContract = {
  "fleet.load": { input: Empty, output: FleetSchema, tags: () => [FLEET_TAG] },
  "mate.launch": {
    input: z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string().optional() }),
    output: ThreadRef,
  },
  "mate.adopt": { input: ThreadRef, output: Done },
  "mate.release": { input: Empty, output: Done },
  "mate.restart": { input: Empty, output: Done },
  "mate.compact": { input: Empty, output: Done },
  "mate.command": { input: z.object({ command: z.enum(["bearings"]), args: z.string() }), output: Done },
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
  "suggestion.dismiss": { input: SuggestionSchema, output: z.array(SuggestionSchema) },
  "charter.compare": { input: Empty, output: z.object({ path: z.string() }) },
  "charter.acknowledge": { input: Empty, output: Done },
  "watch.note": { input: z.object({ file: z.string().min(1) }), output: WatchNoteSchema },
  "watch.toggle": { input: z.object({ name: z.string().min(1), enabled: z.boolean() }), output: z.array(WatchSummarySchema) },
} satisfies PluginRpcContract;
