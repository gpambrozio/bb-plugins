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
  PlacedSentencesSchema,
  RecentHistoryItemSchema,
  SpeechVoiceSchema,
  StoredConfigSchema,
} from "./herald";
import { PushStatusSchema } from "./push";
import { MachineHooksSchema, RunIdSchema, SpeechHooksSchema } from "./speech-hooks";
import { ChoiceInputsSchema, ChoiceOptionSchema, CHOICES_BATCH_MAX } from "./thread-choice";

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
  /**
   * A thread's past sentences with the message each sits above in its
   * timeline, for bb 0.48.1's message metadata; see `server/placement.ts`.
   */
  "history.placed": {
    input: z.object({ threadId: z.string().min(1) }),
    output: PlacedSentencesSchema,
  },
  /**
   * The newest past sentences of every thread, newest first, for the Herald
   * page; as many as the stored `recentHistoryLimit`.
   */
  "history.recent": {
    input: z.object({}),
    output: z.object({ items: z.array(RecentHistoryItemSchema) }),
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
   * What decides each thread's choice of what Herald announces — its own, and
   * the nearest one above it — for the threads a thread menu shows. Threads bb
   * does not know are left out.
   */
  "choices.list": {
    input: z.object({ threadIds: z.array(z.string().min(1)).min(1).max(CHOICES_BATCH_MAX) }),
    output: z.object({ threads: z.record(z.string(), ChoiceInputsSchema) }),
  },
  /** Sets a thread's own choice, or clears it with `default`; every open menu hears of it. */
  "choices.set": {
    input: z.object({ threadId: z.string().min(1), choice: ChoiceOptionSchema }),
    output: ChoiceInputsSchema,
  },
  /**
   * Sets the same choice on several threads at once — a selection in bb's
   * sidebar — and tells every open menu once. Each thread is tried; a failure
   * names how many were not saved.
   */
  "choices.setMany": {
    input: z.object({ threadIds: z.array(z.string().min(1)).min(1).max(CHOICES_BATCH_MAX), choice: ChoiceOptionSchema }),
    output: z.null(),
  },
  /**
   * Whether Herald sends its sentences as push notifications in place of
   * bb's, and when the switch is on but it cannot, why — for the Herald page.
   */
  "push.status": {
    input: z.object({}),
    output: PushStatusSchema,
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
  /** Every machine's speech hooks, by bb host id; a machine with none is left out. */
  "hooks.list": {
    input: z.object({}),
    output: z.object({ hooks: SpeechHooksSchema }),
  },
  /** Sets one machine's two hooks; both empty forgets it. */
  "hooks.set": {
    input: MachineHooksSchema.extend({ hostId: z.string().min(1) }),
    output: z.object({ hooks: SpeechHooksSchema }),
  },
  /**
   * Opens a run of speech on the machine `hostId`, which runs its before hook
   * when no other run is open there, and waits for it; see
   * `server/speech-hooks.ts`. The commands are never in the input: only the
   * ones stored for that machine run. `open` is null when the machine did not
   * answer, and the window ends the run all the same.
   */
  "hooks.begin": {
    input: z.object({ hostId: z.string().min(1), runId: RunIdSchema }),
    output: z.object({ open: z.boolean().nullable(), error: z.string().nullable() }),
  },
  /** Keeps a run open while its window still speaks; a run not renewed ends by itself. */
  "hooks.renew": {
    input: z.object({ hostId: z.string().min(1), runId: RunIdSchema }),
    output: z.object({ open: z.boolean() }),
  },
  /** Ends a run; the last open run on the machine runs its after hook. Safe to repeat. */
  "hooks.end": {
    input: z.object({ hostId: z.string().min(1), runId: RunIdSchema }),
    output: z.object({ error: z.string().nullable() }),
  },
});

export type RpcContract = typeof rpcContract;
