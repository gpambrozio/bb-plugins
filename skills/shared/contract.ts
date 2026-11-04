/**
 * The app ⇄ server contract. The app imports it as a type only: it imports the
 * SDK root, which the app bundle does not provide at run time.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { NewThreadSubjectSchema, SkillDocumentSchema, SkillListSchema, SkillSubjectSchema } from "./skills";

const Id = z.string().min(1);

export const rpcContract = defineRpcContract({
  /**
   * Everything one thread's agent can run, and where each skill comes from —
   * for a thread (`{ threadId }`) or for the new-thread composer's selection
   * (`{ newThread }`).
   */
  list: { input: SkillSubjectSchema, output: SkillListSchema },
  /** One skill's `SKILL.md`, by an id `list` produced for the same subject. */
  read: {
    input: z.union([
      z.object({ threadId: Id, skillId: Id }),
      z.object({ newThread: NewThreadSubjectSchema, skillId: Id }),
    ]),
    output: SkillDocumentSchema,
  },
});

export type RpcContract = typeof rpcContract;
