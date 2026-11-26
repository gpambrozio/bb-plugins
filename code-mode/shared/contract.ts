// The RPCs between the app and the server. The app reads with `experimental_useRpcQuery` and
// `experimental_useRpcKeyedQuery`, which take the contract as a value, so this module must not import
// the SDK at run time (bb provides the SDK root to the server bundle only). `satisfies` gives
// `defineRpcContract`'s checks.
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { configSchema } from "./config";

export const CONFIG_TAG = "config";
/** At most this many threads per read; the server reads bb's metadata 200 at a time. */
export const THREADS_BATCH_MAX = 2000;
export const METADATA_BATCH = 200;

export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

const threadStateSchema = z.object({ state: z.enum(["on", "off", "none"]) });

const hostCheckSchema = z.object({ ok: z.boolean(), message: z.string() });
export type HostCheck = z.infer<typeof hostCheckSchema>;

export const rpcContract = {
  /** Each thread's Code Mode state, keyed by thread id. */
  "threads.state": {
    input: z.object({ keys: z.array(z.string().min(1)).max(THREADS_BATCH_MAX) }),
    output: z.record(z.string(), threadStateSchema),
    keyTags: (key: string) => [threadTag(key)],
  },
  "config.get": { input: z.object({}), output: configSchema, tags: () => [CONFIG_TAG] },
  /** One project name's switch: every bb project with that name. */
  "config.setProjectName": { input: z.object({ name: z.string().min(1), on: z.boolean() }), output: configSchema },
  "config.setHost": { input: z.object({ hostId: z.string().min(1), on: z.boolean() }), output: configSchema },
  /** Select all / Select none: many project names in one write. */
  "config.setProjectNames": { input: z.object({ names: z.array(z.string().min(1)).max(THREADS_BATCH_MAX), on: z.boolean() }), output: configSchema },
  /** Many machines in one write. The app turns on only machines whose wrapper is ready (app/select-all.ts). */
  "config.setHosts": { input: z.object({ hostIds: z.array(z.string().min(1)).max(THREADS_BATCH_MAX), on: z.boolean() }), output: configSchema },
  /** Writes the wrapper on that machine and says whether it worked. */
  "hosts.check": { input: z.object({ hostId: z.string().min(1) }), output: hostCheckSchema },
} satisfies PluginRpcContract;

export type RpcContract = typeof rpcContract;
