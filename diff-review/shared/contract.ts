/**
 * The Review tab's RPCs. This module imports the SDK root, so the app imports it as a type only
 * (`useRpc<typeof rpcContract>()`); the schemas it needs at run time are in `types.ts`.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  ANCHOR_MAX_CHARS,
  BODY_MAX_CHARS,
  reviewThreadSchema,
  executionSchema,
  REVIEW_FOCUSES,
  reviewViewSchema,
  runSchema,
  severitySchema,
  sideSchema,
  targetRequestSchema,
  targetSchema,
  threadStatusSchema,
} from "./types";

const id = z.string().min(1).max(64);
const body = z.string().max(BODY_MAX_CHARS);
const threadResult = z.object({ thread: reviewThreadSchema }).strict();

export const rpcContract = defineRpcContract({
  getReview: {
    input: z
      .object({
        threadId: id,
        target: targetRequestSchema,
        /** The tab's first load: an empty uncommitted view may give way to the branch's commits. */
        autoTarget: z.boolean().optional(),
      })
      .strict(),
    output: reviewViewSchema,
  },
  loadPatches: {
    input: z.object({ threadId: id, target: targetSchema, paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }).strict(),
    output: z.object({ patches: z.array(z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() }).strict()) }).strict(),
  },
  listThreads: {
    input: z.object({ sessionId: id }).strict(),
    output: z.object({ threads: z.array(reviewThreadSchema), runs: z.array(runSchema) }).strict(),
  },
  createThread: {
    input: z
      .object({
        sessionId: id,
        /** The thread whose Review tab it was written in; an @-mention's run becomes its child. */
        threadId: id.optional(),
        filePath: z.string().min(1).max(4096),
        side: sideSchema.nullable(),
        startLine: z.number().int().min(0),
        endLine: z.number().int().min(0),
        severity: severitySchema.nullable(),
        anchorContent: z.string().max(ANCHOR_MAX_CHARS).nullable(),
        body,
      })
      .strict(),
    output: threadResult,
  },
  addComment: {
    input: z.object({ reviewThreadId: id, body, threadId: id.optional() }).strict(),
    output: threadResult,
  },
  editComment: {
    input: z.object({ commentId: id, body }).strict(),
    output: threadResult,
  },
  deleteComment: {
    input: z.object({ commentId: id }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  setStatus: {
    input: z.object({ reviewThreadId: id, status: threadStatusSchema }).strict(),
    output: threadResult,
  },
  send: {
    input: z
      .object({
        sessionId: id,
        threadId: id,
        reviewThreadIds: z.array(id).min(1).max(200),
        note: z.string().max(BODY_MAX_CHARS),
      })
      .strict(),
    output: z.object({ delivery: z.enum(["sent", "queued"]), count: z.number() }).strict(),
  },
  runDefaults: {
    input: z.object({ threadId: id }).strict(),
    output: z
      .object({ execution: executionSchema.nullable(), message: z.string().nullable(), permissionMode: z.enum(["auto", "accept-edits"]) })
      .strict(),
  },
  startReview: {
    input: z
      .object({
        sessionId: id,
        /** The thread under review; the run's thread becomes its child. */
        threadId: id,
        focuses: z.array(z.string().min(1).max(64)).max(REVIEW_FOCUSES.length + 10),
        instructions: z.string().max(BODY_MAX_CHARS),
        execution: executionSchema,
      })
      .strict(),
    output: z.object({ run: runSchema }).strict(),
  },
  fixInNewThread: {
    input: z
      .object({
        sessionId: id,
        /** The thread under review; the fix thread becomes its child. */
        threadId: id,
        reviewThreadIds: z.array(id).min(1).max(200),
        note: z.string().max(BODY_MAX_CHARS),
        execution: executionSchema,
      })
      .strict(),
    output: z.object({ run: runSchema, count: z.number() }).strict(),
  },
  closeRun: {
    input: z.object({ runId: id }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export type RpcContract = typeof rpcContract;
