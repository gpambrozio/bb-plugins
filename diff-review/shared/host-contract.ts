/**
 * The contract between the server and the host entry (`host.ts`), which runs git in the workspace's
 * checkout on whichever machine holds it. Imports the SDK root: never import it from the app.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { hostDiffSpecSchema } from "./git-spec";

const fileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    changeKind: z.enum(["added", "copied", "deleted", "modified", "renamed", "type_changed"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    untracked: z.boolean(),
    /** Null when the file's patch is too large to send (`too_large`) or it is binary. */
    patch: z.string().nullable(),
    tooLarge: z.boolean(),
  })
  .strict();
export type HostDiffFile = z.infer<typeof fileSchema>;

export const hostDiffSchema = z
  .object({
    files: z.array(fileSchema),
    /** Files were left out: the diff has more than the host sends. */
    truncated: z.boolean(),
    /** The commits the two sides are, when they are commits. */
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
  })
  .strict();
export type HostDiff = z.infer<typeof hostDiffSchema>;

export const hostContract = defineRpcContract({
  diff: {
    experimental_retryable: true,
    input: z
      .object({
        /** The workspace's checkout, an absolute path on the host. */
        root: z.string().min(1).max(4096),
        spec: hostDiffSpecSchema,
        ignoreWhitespace: z.boolean(),
      })
      .strict(),
    output: hostDiffSchema,
  },
});

export type HostContract = typeof hostContract;
