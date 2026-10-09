/**
 * The contract between the server entry and the host entry that runs on each
 * Mac (host.ts). The server relays a session to a Mac that is not its own
 * through it: `open` connects to that Mac's own 127.0.0.1:5900, `write`
 * carries the viewer's bytes up in order, the `data` signal carries the Mac's
 * bytes down in order, and `ack` returns credit so the host reads from Screen
 * Sharing only as fast as the viewer takes it. Bytes travel as base64, since
 * host calls and signals are JSON.
 *
 * Neither end parses the bytes. The app never imports this file.
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { ScreenCheckSchema } from "./channels";

/** The most raw bytes one `write` or one `data` signal carries. */
export const MAX_CHUNK_BYTES = 128 * 1024;
/** base64 is 4 characters for every 3 bytes. */
const MAX_CHUNK_BASE64 = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;

const SessionId = z.string().min(1).max(128);
const Seq = z.number().int().nonnegative();
const Chunk = z.string().max(MAX_CHUNK_BASE64);
const Empty = z.object({});

export const hostContract = defineRpcContract({
  /** Whether Screen Sharing answers on this Mac; read-only, signs in to nothing. */
  status: { input: Empty, output: ScreenCheckSchema },
  /** Connects a session to this Mac's Screen Sharing. Resolves once the TCP connection is up. */
  open: { input: z.object({ sessionId: SessionId }), output: Empty },
  /** The viewer's next bytes. `seq` counts from 0; one out of order ends the session. */
  write: { input: z.object({ sessionId: SessionId, seq: Seq, data: Chunk }), output: Empty },
  /** The viewer has received `bytes` of the session's data in all. */
  ack: { input: z.object({ sessionId: SessionId, bytes: Seq }), output: Empty },
  /** The server still wants the session. `open` is false when the host no longer has it. */
  keepalive: { input: z.object({ sessionId: SessionId }), output: z.object({ open: z.boolean() }) },
  /** Ends a session. Safe for one the host does not know. */
  close: { input: z.object({ sessionId: SessionId }), output: Empty },
});

export type HostContract = typeof hostContract;

export const hostSignals = {
  /** The Mac's next bytes. `seq` counts from 0; the server ends the session on a gap. */
  data: { payload: z.object({ sessionId: SessionId, seq: Seq, data: Chunk }) },
  /** The host ended a session itself, after its last `data`. */
  closed: { payload: z.object({ sessionId: SessionId, reason: z.string().max(200), failed: z.boolean() }) },
} satisfies ExperimentalHostSignals;

export type HostSignals = typeof hostSignals;
