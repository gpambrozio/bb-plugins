/**
 * The contract between the server and the host entry (`host.ts`), which runs git in the workspace's
 * checkout on whichever machine holds it. Imports the SDK root: never import it from the app.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { hostDiffSpecSchema, hostRangeSpecSchema, revisionSchema } from "./git-spec";

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
  /** A fingerprint of what is staged (`git diff --cached --raw`), to tell the staged and unstaged views changed. */
  indexState: {
    experimental_retryable: true,
    input: z.object({ root: z.string().min(1).max(4096) }).strict(),
    output: z.object({ key: z.string() }).strict(),
  },
  /**
   * Reverts an uncommitted change in the checkout, only while the file still is the version the tab
   * showed (`revision`, as bb's Git plugin lists it); see `host/revert.ts`.
   */
  revert: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        path: z.string().min(1).max(4096),
        revision: z.string().min(1).max(1024),
        hunks: z.array(z.number().int().min(0)).min(1).max(1000).nullable(),
        patch: z.string().max(8 * 1024 * 1024).nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /**
   * The two commits a range view compares, as `diff` resolves them (from the merge base, or for a
   * merged `a...b` from where it forked), so an AI run reads the diff the tab shows.
   */
  rangeCommits: {
    experimental_retryable: true,
    input: z.object({ root: z.string().min(1).max(4096), spec: hostRangeSpecSchema }).strict(),
    output: z.object({ baseSha: z.string(), headSha: z.string() }).strict(),
  },
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
  /**
   * Fetches a GitHub pull request's head and its base branch into private refs
   * (`refs/diff-review/pull/<n>/head` and `/base`), without touching any branch, the index or the
   * working tree, and answers the two commits.
   */
  fetchPull: {
    input: z
      .object({
        root: z.string().min(1).max(4096),
        url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
        number: z.number().int().positive(),
        baseRef: revisionSchema,
      })
      .strict(),
    output: z.object({ headSha: z.string(), baseSha: z.string() }).strict(),
  },
});

export type HostContract = typeof hostContract;
