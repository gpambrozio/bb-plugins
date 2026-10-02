/**
 * The RPC contract between the app and the server. The server registers it;
 * the app imports its type only — see `shared/herald.ts` for why.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  AttentionEntrySchema,
  HistoryItemSchema,
  MAX_SPEECH_CHARS,
  SpeechVoiceSchema,
  StoredConfigSchema,
} from "./herald";

export const rpcContract = defineRpcContract({
  /** Every thread waiting on the user that Herald knows why for; see `server/liveness.ts`. */
  list: {
    input: z.object({}),
    output: z.object({ entries: z.array(AttentionEntrySchema) }),
  },
  /** A thread's past sentences, newest first, for its Herald panel. */
  "history.list": {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ items: z.array(HistoryItemSchema) }),
  },
  "config.get": {
    input: z.object({}),
    output: StoredConfigSchema,
  },
  /** Any part of the stored configuration; the rest is kept. */
  "config.set": {
    input: StoredConfigSchema.partial(),
    output: StoredConfigSchema,
  },
  /**
   * A line from the app for `bb plugin logs herald`: the announcer says here
   * what it spoke and why it stayed quiet, since the app's console is out of
   * reach on most clients.
   */
  log: {
    input: z.object({ level: z.enum(["info", "warn"]), message: z.string().max(2000) }),
    output: z.null(),
  },
  /**
   * The bb server Mac's `say` voices, and whether `say` is there at all. The
   * app cannot run a command, but the server can, and its voices are better
   * than a browser's; so the server renders the sentence and the app plays it.
   */
  "speech.voices": {
    input: z.object({}),
    output: z.object({ available: z.boolean(), voices: z.array(SpeechVoiceSchema) }),
  },
  "speech.render": {
    input: z.object({
      text: z.string().min(1).max(MAX_SPEECH_CHARS),
      /** A `say` voice name, or empty for the Mac's default. */
      voice: z.string().default(""),
      /** A multiplier on the voice's natural pace. */
      rate: z.number().min(0.5).max(2).default(1),
    }),
    output: z.object({ mimeType: z.string(), base64: z.string() }),
  },
});

export type RpcContract = typeof rpcContract;
