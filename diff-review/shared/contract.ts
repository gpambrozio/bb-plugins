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
  reviewViewSchema,
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
    input: z.object({ threadId: id, target: targetRequestSchema }).strict(),
    output: reviewViewSchema,
  },
  loadPatches: {
    input: z.object({ threadId: id, target: targetSchema, paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }).strict(),
    output: z.object({ patches: z.array(z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() }).strict()) }).strict(),
  },
  listThreads: {
    input: z.object({ sessionId: id }).strict(),
    output: z.object({ threads: z.array(reviewThreadSchema) }).strict(),
  },
  createThread: {
    input: z
      .object({
        sessionId: id,
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
    input: z.object({ reviewThreadId: id, body }).strict(),
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
});

export type RpcContract = typeof rpcContract;
