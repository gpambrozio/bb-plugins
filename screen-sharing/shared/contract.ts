/**
 * The RPC contract between the app and the server. The app imports this file
 * as a type only: it imports `defineRpcContract` from the SDK root, which only
 * the server bundle has.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { HostListSchema, ScreenStatusSchema, SessionListSchema } from "./channels";

const Empty = z.object({});
const OneHost = z.object({ hostId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  /** The machines enrolled in this bb, the server's own first. Asks none of them anything. */
  hosts: { input: Empty, output: HostListSchema },
  /** Whether Screen Sharing answers on one of them. */
  status: { input: OneHost, output: ScreenStatusSchema },
  /**
   * A single-use ticket for one WebSocket to the relay, for that Mac only,
   * valid for a few seconds.
   */
  openSession: {
    input: OneHost,
    output: z.object({ token: z.string(), expiresAt: z.number() }),
  },
  /** The open sessions, from every window and device. */
  sessions: { input: Empty, output: SessionListSchema },
  /** Ends every open session, on every Mac. */
  closeAll: { input: Empty, output: z.object({ closed: z.number().int() }) },
});

export type RpcContract = typeof rpcContract;
