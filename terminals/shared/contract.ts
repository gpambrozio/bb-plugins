/**
 * The RPC contract between the app and the server. The app imports this file
 * as a type only: it imports `defineRpcContract` from the SDK root, which only
 * the server bundle has (see app/imports.test.ts).
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HostChoiceSchema, TabViewSchema } from "./tabs";

const Empty = z.object({});
/** The bounds bb's own terminal endpoint accepts. */
const Cols = z.number().int().min(1).max(500);
const Rows = z.number().int().min(1).max(200);

export const rpcContract = defineRpcContract({
  /** The machines "+" can open a terminal on, the server's own first. */
  hosts: { input: Empty, output: z.object({ hosts: z.array(HostChoiceSchema) }) },
  /** Every open tab, in opening order, with where its shell is. */
  list: { input: Empty, output: z.object({ tabs: z.array(TabViewSchema) }) },
  /** Opens a shell in the home directory of `hostId`, as a new tab at the end. */
  open: { input: z.object({ hostId: z.string().min(1), cols: Cols, rows: Rows }), output: TabViewSchema },
  /** Closes the tab and ends its shell. Closing a tab that is already gone succeeds. */
  close: { input: z.object({ terminalId: z.string().min(1) }), output: Empty },
});

export type RpcContract = typeof rpcContract;
