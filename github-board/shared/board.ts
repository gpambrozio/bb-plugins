import { z } from "zod";

/**
 * The four columns the board renders, in display order. Draft and open pull
 * requests come from a single search and are split by `isDraft`, so the column
 * id is presentation only — see `fetchPullRequests` in server/github.ts.
 */
export const COLUMN_IDS = ["issues", "draft-prs", "open-prs", "discussions"] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

/**
 * An issue a pull request closes, as GitHub's `closingIssuesReferences` reports
 * it. The id is the same node id `the issue search` returns, so the board can
 * match a linked issue to its card by identity rather than by number.
 */
export const LinkedIssueSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  repository: z.string(),
});

/**
 * A pull request's checks, folded to the three counts a card shows: passed,
 * failed, and still running. Skipped and cancelled checks are counted nowhere —
 * they are neither a result nor a wait — which is the same fold Paseo's own
 * workspace hover card does.
 */
export const CheckSummarySchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  pending: z.number().int().min(0),
});

/**
 * How a pull request's branch stands against the branch it targets — its base,
 * which is `main` for most pull requests and another feature branch for a
 * stacked one. "Out of date" is GitHub's own phrase for `behindBy > 0`.
 */
export const BranchStatusSchema = z.object({
  /** Commits on the base the head does not have yet. 0 is up to date. */
  behindBy: z.number().int().min(0),
  /**
   * Behind, free of known conflicts, *and* this login may bring it up to date —
   * GitHub's own `viewerCanUpdateBranch`, the condition behind its "Update
   * branch" button, less the conflicts that flag does not rule out.
   */
  canUpdate: z.boolean(),
  /**
   * The branch and its base change the same lines, so nothing can bring it up
   * to date automatically: someone has to resolve them. False while GitHub has
   * not worked it out yet — it computes this lazily, starting when first asked.
   */
  conflicts: z.boolean(),
});

export const BoardItemSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  /** `owner/name`, the only repository form the board displays. */
  repository: z.string(),
  updatedAt: z.string(),
  commentsCount: z.number().int(),
  labels: z.array(z.string()),
  /**
   * Who opened it, or null when GitHub reports no author because the account is
   * gone. The board queries its own repositories as well as its own work, so a
   * card is not necessarily the viewer's; the card names the author when it is
   * someone else's.
   */
  author: z.string().nullable(),
  /** Column-specific trailing detail, e.g. a discussion's category. */
  detail: z.string().nullable(),
  /**
   * Pull requests only, empty everywhere else. The board renders these as pills
   * on the pull request card and drops the matching cards from the Issues
   * column, so one piece of work occupies one card.
   */
  linkedIssues: z.array(LinkedIssueSchema),
  /**
   * Open pull requests only. Null wherever the board shows no pills at all: an
   * item that is not a pull request, a draft — whose CI is not yet anyone's
   * business — or a head commit nothing has ever reported a check on.
   */
  checks: CheckSummarySchema.nullable(),
  /**
   * Draft and open pull requests. Null for an issue or a discussion, and for a
   * pull request GitHub would not compare — its base branch is gone, or the
   * request that asks failed, which costs the pill and the button and nothing
   * else.
   */
  branch: BranchStatusSchema.nullable(),
});

/**
 * A label as its repository defines it. `color` is six hex digits with no `#`,
 * exactly as GitHub stores it — it is data belonging to the label, not one of
 * the plugin theme's tokens, which is why the menu is allowed to paint with it.
 */
export const RepositoryLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

/**
 * The first message a card is sent with, one template per column — the four
 * columns are the four kinds of work the board shows, so the column id doubles
 * as the template key. It is what the launch dialog opens on; the user is free
 * to rewrite it before sending.
 *
 * Templates carry `{url}`, `{title}`, `{number}` and `{repository}`; anything
 * else in braces is left alone rather than blanked, so an unknown placeholder
 * shows up in the prompt instead of vanishing.
 */
export const PromptSetSchema = z.object({
  issues: z.string(),
  "draft-prs": z.string(),
  "open-prs": z.string(),
  discussions: z.string(),
});

export const PromptSettingsSchema = z.object({
  /** Always complete on the way out: the server fills a blank with its default. */
  byType: PromptSetSchema,
  /**
   * Keyed by bb project id, and partial on purpose — a type absent here, or
   * present but blank, inherits `byType`. Storing the inherited value instead
   * would freeze a copy that stops tracking the default it came from.
   *
   * Projects rather than repositories: a card can only be sent to a project in
   * the first place, and a fork's origin and upstream are two repositories but
   * one project, which should not need configuring twice.
   */
  byProject: z.record(z.string(), PromptSetSchema.partial()),
});

export const BoardColumnSchema = z.object({
  id: z.enum(COLUMN_IDS),
  title: z.string(),
  items: z.array(BoardItemSchema),
  /**
   * Set when this column alone failed. Columns fail independently so a missing
   * `read:discussion` scope does not blank the issues and pull request columns.
   */
  error: z.string().nullable(),
});

export const BoardSchema = z.object({
  /** The concrete login every query ran against, never the `@me` alias. */
  login: z.string(),
  columns: z.array(BoardColumnSchema),
  /**
   * `owner/name` to project id, for the repositories on this board only. The
   * surface needs it to pick a template during the press gesture, and it is
   * keyed the way a card spells its repository so no host parsing is needed on
   * the client.
   */
  repositoryProjects: z.record(z.string(), z.string()),
  fetchedAt: z.string(),
});

export type PromptSet = z.output<typeof PromptSetSchema>;
export type PromptSettings = z.output<typeof PromptSettingsSchema>;
export type LinkedIssue = z.output<typeof LinkedIssueSchema>;
export type RepositoryLabel = z.output<typeof RepositoryLabelSchema>;
export type CheckSummary = z.output<typeof CheckSummarySchema>;
export type BranchStatus = z.output<typeof BranchStatusSchema>;
export type BoardItem = z.output<typeof BoardItemSchema>;
export type BoardColumn = z.output<typeof BoardColumnSchema>;
export type Board = z.output<typeof BoardSchema>;

/**
 * What a card knows about itself already — title, repository, labels, author —
 * is left off this shape on purpose: the panel paints those from the card the
 * moment it opens, and this round trip only adds what the search never fetched.
 */
export const ItemDetailsSchema = z.object({
  /**
   * `open` for everything the board lists today; the rest cover an item that
   * changed on GitHub after the board was fetched, which the panel is the first
   * place to notice. A draft pull request reads `draft` rather than `open`.
   */
  state: z.enum(["open", "draft", "closed", "merged"]),
  /** Markdown, exactly as GitHub stores it. Empty when the author wrote nothing. */
  body: z.string(),
  createdAt: z.string(),
  /** Logins. Always empty for a discussion, which GitHub does not assign. */
  assignees: z.array(z.string()),
  /** Pull requests only: the branch under review and the one it targets. */
  branches: z.object({ head: z.string(), base: z.string() }).nullable(),
});

export type ItemDetails = z.output<typeof ItemDetailsSchema>;

/** One comment on a card, or one reply in a discussion thread. */
export const ItemCommentSchema = z.object({
  id: z.string(),
  /** Null for a deleted account, as with `BoardItem.author`. */
  author: z.string().nullable(),
  createdAt: z.string(),
  /** Markdown, as GitHub stores it. */
  body: z.string(),
  /**
   * 0 for a comment on the item, 1 for a reply to one — discussions thread
   * their comments one level deep, and the panel indents replies to say so.
   * Issue and pull request comments are always 0.
   */
  depth: z.number().int().min(0),
});

export type ItemComment = z.output<typeof ItemCommentSchema>;
