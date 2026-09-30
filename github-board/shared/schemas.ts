/**
 * The shapes the app and the server exchange outside the RPC contract's own
 * definition, and the realtime channels. Kept apart from `shared/contract.ts`
 * because the app needs these at run time, and the contract imports
 * `defineRpcContract` from the SDK root, which only the server bundle can
 * resolve — a git install has no SDK in `node_modules` to bundle.
 */
import { z } from "zod";

import { BoardItemSchema } from "./board";

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

export type NewThreadRequestInput = z.input<typeof NewThreadRequestSchema>;

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
