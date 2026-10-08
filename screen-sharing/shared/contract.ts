/**
 * The RPC contract between the app and the server. The app imports this file
 * as a type only: it imports `defineRpcContract` from the SDK root, which only
 * the server bundle has.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { ScreenStatusSchema, SessionListSchema } from "./channels";

const Empty = z.object({});

export const rpcContract = defineRpcContract({
  /** Whether Screen Sharing answers on the Mac running the bb server. */
  status: { input: Empty, output: ScreenStatusSchema },
  /**
   * A single-use ticket for one WebSocket to the relay, valid for a few
   * seconds. `hostId` must be the Mac running the bb server; any other is
   * refused in this version.
   */
  openSession: {
    input: z.object({ hostId: z.string().min(1) }),
    output: z.object({ token: z.string(), expiresAt: z.number() }),
  },
  /** The open sessions, from every window and device. */
  sessions: { input: Empty, output: SessionListSchema },
  /** Ends every open session. */
  closeAll: { input: Empty, output: z.object({ closed: z.number().int() }) },
});

export type RpcContract = typeof rpcContract;
