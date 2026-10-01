/**
 * The app ⇄ server contract. The app imports it as a type only: it imports the
 * SDK root, which the app bundle does not provide at run time.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { SkillDocumentSchema, SkillListSchema } from "./skills";

const ThreadId = z.string().min(1);

export const rpcContract = defineRpcContract({
  /** Everything one thread's agent can run, and where each skill comes from. */
  list: { input: z.object({ threadId: ThreadId }), output: SkillListSchema },
  /** One skill's `SKILL.md`, by an id `list` produced for the same thread. */
  read: { input: z.object({ threadId: ThreadId, skillId: z.string().min(1) }), output: SkillDocumentSchema },
});

export type RpcContract = typeof rpcContract;
