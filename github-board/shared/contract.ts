/**
 * The RPC contract between the app and the server, and the realtime channels
 * the server publishes on. The app imports this file's types only; the server
 * registers it.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  BoardItemSchema,
  BoardSchema,
  BranchStatusSchema,
  ItemCommentSchema,
  ItemDetailsSchema,
  PromptSettingsSchema,
  RepositoryLabelSchema,
} from "./board";

/**
 * How the board is drawn, for every client of this bb. Stored by the plugin
 * because neither is a form field: the filter is toggled in the board's own
 * menu and the width is dragged.
 */
export const DisplayPrefsSchema = z.object({
  /** The repository filter, stored as the repositories to hide. */
  hiddenRepositories: z.array(z.string()),
  /**
   * The detail panel's width as a share of the board's body, or null for the
   * default. A share rather than pixels: the width was chosen against one
   * window and has to fit a different one.
   */
  detailWidthFraction: z.number().min(0).max(1).nullable(),
});

export type DisplayPrefs = z.output<typeof DisplayPrefsSchema>;

/**
 * What the send dialog opens on: the selections of the last thread a card
 * was sent to, as the composer returned them. A preference, never a promise —
 * the composer reconciles a model or level that no longer exists.
 */
export const LaunchDefaultsSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  permissionMode: z.string(),
  serviceTier: z.string().optional(),
  environment: z.json().optional(),
});

export type LaunchDefaults = z.output<typeof LaunchDefaultsSchema>;

/** The card a thread is started on; stored in the thread's plugin metadata. */
export const SentCardSchema = BoardItemSchema.pick({
  id: true,
  repository: true,
  number: true,
  title: true,
  url: true,
  author: true,
  labels: true,
});

export type SentCard = z.output<typeof SentCardSchema>;

/**
 * The composer's `NewThreadRequest`, checked for the fields this plugin reads
 * and otherwise passed to `threads.spawn` as the composer built it; bb
 * validates the rest.
 */
export const NewThreadRequestSchema = z.looseObject({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: z.string(),
  permissionMode: z.string(),
  serviceTier: z.string().optional(),
  environment: z.json(),
  executionInputSources: z.json(),
  input: z.array(z.json()),
});

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

/** Published with `{ itemId, patch }` when a label or a branch changes, so every open board adopts it. */
export const ITEM_PATCHED = "item-patched";
/** Published with the new `DisplayPrefs`. */
export const DISPLAY_PREFS_CHANGED = "display-prefs-changed";
/** Published with the new `PromptSettings`. */
export const PROMPTS_CHANGED = "prompts-changed";

export const ItemPatchSchema = z.object({
  itemId: z.string(),
  patch: BoardItemSchema.pick({ labels: true, branch: true }).partial(),
});

export type ItemPatch = z.output<typeof ItemPatchSchema>;
