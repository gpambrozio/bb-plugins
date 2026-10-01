/**
 * The RPC contract between the app and the server: one method, `load`.
 *
 * The app imports this file as a type only: it imports `defineRpcContract`
 * from the SDK root, which only the server bundle has (`app/imports.test.ts`).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";

import { LoadInputSchema, LoadOutputSchema } from "./pricing";

export const rpcContract = defineRpcContract({
  /** The rows for these providers, from the cache or the network, and a status per upstream. */
  load: { input: LoadInputSchema, output: LoadOutputSchema },
});

export type RpcContract = typeof rpcContract;
