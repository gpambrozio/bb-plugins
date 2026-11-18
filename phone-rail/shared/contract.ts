/**
 * The RPC contract between the app and the server. The app imports this file
 * as a type only: it imports `defineRpcContract` from the SDK root, which only
 * the server bundle has (see app/imports.test.ts).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { NavigationLayoutSchema } from "./layout";

export const rpcContract = defineRpcContract({
  /** The phone layout, or null when phones follow bb's shared preferences. */
  getPhoneLayout: { input: z.object({}), output: z.object({ layout: NavigationLayoutSchema.nullable() }) },
  /** Saves the phone layout for every phone-sized client; null goes back to bb's shared preferences. */
  setPhoneLayout: { input: z.object({ layout: NavigationLayoutSchema.nullable() }), output: z.object({}) },
});

export type RpcContract = typeof rpcContract;
