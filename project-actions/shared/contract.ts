// The app ⇄ server RPC contract. The app imports it as a type only (`app/imports.test.ts`): the
// SDK root it imports is provided to the server bundle alone.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { LIMITS } from "./actions-file";
import { ActionsListSchema, EditorFileSchema, RunOutcomeSchema, SaveResultSchema } from "./views";

const ThreadInput = z.object({ threadId: z.string().min(1).max(200) });

export const rpcContract = defineRpcContract({
  /** The thread's actions file, read from its workspace now, with each action's last run. */
  list: { input: ThreadInput, output: ActionsListSchema },
  /** Starts an action in a terminal of the thread, or answers the terminal it is still running in. */
  run: { input: ThreadInput.extend({ name: z.string().min(1).max(200) }), output: RunOutcomeSchema },
  /** The thread's actions file as the editor opens it. */
  read: { input: ThreadInput, output: EditorFileSchema },
  /**
   * Writes the file in the thread's workspace, if it checks out and is still the one the editor read
   * (`expectedSha256`, null for a file that did not exist).
   */
  save: { input: ThreadInput.extend({ text: z.string().max(LIMITS.fileBytes), expectedSha256: z.string().nullable() }), output: SaveResultSchema },
});

export type RpcContract = typeof rpcContract;
