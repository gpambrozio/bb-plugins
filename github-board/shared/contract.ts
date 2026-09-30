/**
 * The RPC contract between the app and the server. The server registers it;
 * the app imports its type only — see `shared/schemas.ts` for why.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  BoardSchema,
  BranchStatusSchema,
  ItemCommentSchema,
  ItemDetailsSchema,
  PromptSettingsSchema,
  RepositoryLabelSchema,
} from "./board";
import {
  DisplayPrefsSchema,
  LaunchDefaultsSchema,
  NewThreadRequestSchema,
  SentCardSchema,
} from "./schemas";

const ProjectChoiceSchema = z.object({ id: z.string(), name: z.string() });

export const rpcContract = defineRpcContract({
  loadBoard: {
    input: z.object({
      limit: z.number().int().min(1).max(100).default(30),
      /** Set by the Refresh button to bypass the server's short-lived board cache. */
      force: z.boolean().default(false),
    }),
    output: BoardSchema,
  },
  loadItem: {
    input: z.object({ id: z.string().min(1), force: z.boolean().default(false) }),
    output: ItemDetailsSchema,
  },
  loadComments: {
    input: z.object({ id: z.string().min(1), force: z.boolean().default(false) }),
    output: z.object({ comments: z.array(ItemCommentSchema), truncated: z.boolean() }),
  },
  /** One GitHub-hosted image, fetched with the token and answered as a data URL. */
  loadImage: {
    input: z.object({ url: z.string().min(1) }),
    output: z.object({ dataUrl: z.string() }),
  },
  listLabels: {
    input: z.object({ repository: z.string().min(1) }),
    output: z.object({ labels: z.array(RepositoryLabelSchema) }),
  },
  /** Answers the item's labels as GitHub reports them after the change. */
  toggleLabel: {
    input: z.object({ itemId: z.string().min(1), labelId: z.string().min(1), add: z.boolean() }),
    output: z.object({ labels: z.array(z.string()) }),
  },
  /** GitHub's Update branch, after a last look; `updated: false` means nothing was sent. */
  updateBranch: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ updated: z.boolean(), branch: BranchStatusSchema }),
  },
  getDisplayPrefs: {
    input: z.object({}),
    output: DisplayPrefsSchema,
  },
  setDisplayPrefs: {
    input: DisplayPrefsSchema.partial(),
    output: DisplayPrefsSchema,
  },
  getPrompts: {
    input: z.object({}),
    output: PromptSettingsSchema,
  },
  /** Saves the templates normalised (blank means inherit) and answers what was stored. */
  savePrompts: {
    input: PromptSettingsSchema,
    output: PromptSettingsSchema,
  },
  /** The project a card opens the send dialog on, the others it matches, and the saved selections. */
  sendOptions: {
    input: z.object({ repository: z.string(), url: z.string() }),
    output: z.object({
      project: ProjectChoiceSchema.nullable(),
      candidates: z.array(ProjectChoiceSchema),
      launch: LaunchDefaultsSchema.nullable(),
    }),
  },
  /** Starts the thread the composer described, on the card, and remembers its selections. */
  send: {
    input: z.object({ card: SentCardSchema, request: NewThreadRequestSchema }),
    output: z.object({ threadId: z.string() }),
  },
});

export type RpcContract = typeof rpcContract;
