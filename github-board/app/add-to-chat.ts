/**
 * Add to chat: what a card puts into a chat's draft, which chats the picker
 * offers, and what each is called there.
 *
 * The card goes in as the prompt Send to chat would start the thread with: its
 * column's template, with the override of the chat's own project when it has
 * one, filled in with the card. It lands on its own paragraph after whatever
 * the draft already holds. Never at the cursor: a cursor insert replaces
 * selected text, and the draft is the user's. Nothing is sent; the user reads
 * it and sends it.
 *
 * Pure apart from the handle it is given, so it is tested with a fake one.
 */
import type { PluginComposerApi, PluginComposerScope, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

import type { BoardItem, ColumnId, PromptSettings } from "../shared/board";
import { renderTemplate, templateFor } from "../shared/settings";

/**
 * The card as the prompt Send to chat would use in project `projectId`. A chat
 * with no project gets the column's template with no override, as Send to chat
 * does for a card that reaches no project.
 */
export function cardPrompt(
  prompts: PromptSettings,
  item: Pick<BoardItem, "repository" | "number" | "title" | "url">,
  column: ColumnId,
  projectId: string | null,
): string {
  return renderTemplate(templateFor(prompts, column, projectId), item);
}

/**
 * The bb project a composer writes into: a new thread's selected project, or
 * the project of the thread it belongs to as the sidebar lists it. Null when
 * neither is known — a new-thread composer that has not resolved its project,
 * or a thread the sidebar does not list.
 */
export function composerProjectId(
  scope: PluginComposerScope,
  threads: readonly Pick<PluginSidebarThread, "id" | "projectId">[],
): string | null {
  if (scope.kind === "new-thread") return scope.projectId;
  return threads.find((thread) => thread.id === scope.threadId)?.projectId ?? null;
}

/** What the picker needs from bb's sidebar to name a composer. */
export interface ComposerNames {
  threads: readonly { id: string; displayTitle: string }[];
  projects: readonly { id: string; name: string }[];
}

/** The sidebar thread fields the picker reads. */
export type SidebarThreadFields = Pick<
  PluginSidebarThread,
  "id" | "projectId" | "displayTitle" | "isHidden" | "isArchived" | "updatedAt"
>;

/** A thread whose chat is not on screen: picking it opens the chat, then adds the card. */
export interface ThreadTarget {
  threadId: string;
  title: string;
  /** The thread's project, whose prompt override the card is written with. */
  projectId: string;
  projectName: string | null;
}

export interface ChatTargets<Composer> {
  /** `projectId` picks the prompt override, as `composerProjectId` resolves it. */
  onScreen: { composer: Composer; label: string; projectId: string | null }[];
  threads: ThreadTarget[];
}

/** How many threads that are not on screen the picker lists. */
export const THREAD_TARGET_LIMIT = 8;

/**
 * What the picker offers: the chats on screen first, in bb's order, then the
 * threads that are not, the card's own projects' first and the most recently
 * updated first within each. A thread whose chat is on screen is listed once,
 * as on screen; hidden helper threads and archived ones are left out.
 *
 * While the board's Send to chat dialog is open, every new-thread composer is
 * left out: the dialog's own composer is one, and `useComposers()` lists it
 * like any other. Nothing in a composer handle names the component that drew
 * it, so the board's own state is what tells the two apart — and with the
 * dialog open over the board, no other new-thread composer can be picked
 * from it anyway.
 */
export function chatTargets<Composer extends Pick<PluginComposerApi, "scope">>({
  composers,
  threads,
  projects,
  cardProjectIds,
  sendDialogOpen,
  limit = THREAD_TARGET_LIMIT,
}: {
  composers: readonly Composer[];
  threads: readonly SidebarThreadFields[];
  projects: readonly { id: string; name: string }[];
  cardProjectIds: ReadonlySet<string>;
  sendDialogOpen: boolean;
  limit?: number;
}): ChatTargets<Composer> {
  const names: ComposerNames = { threads, projects };
  const onScreen = composers
    .filter((composer) => !(sendDialogOpen && composer.scope.kind === "new-thread"))
    .map((composer) => ({
      composer,
      label: composerLabel(composer.scope, names),
      projectId: composerProjectId(composer.scope, threads),
    }));

  const shown = new Set<string>();
  for (const { composer } of onScreen) {
    if (composer.scope.kind === "thread") shown.add(composer.scope.threadId);
  }
  const rank = (thread: SidebarThreadFields) => (cardProjectIds.has(thread.projectId) ? 0 : 1);
  const others = threads
    .filter((thread) => !thread.isHidden && !thread.isArchived && !shown.has(thread.id))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((thread) => ({
      threadId: thread.id,
      title: thread.displayTitle,
      projectId: thread.projectId,
      projectName: projects.find((project) => project.id === thread.projectId)?.name ?? null,
    }));
  return { onScreen, threads: others };
}

/** A composer's name in the picker: the thread it writes to, or the project a new thread would start in. */
export function composerLabel(scope: PluginComposerScope, names: ComposerNames): string {
  if (scope.kind === "new-thread") {
    const project = names.projects.find((candidate) => candidate.id === scope.projectId);
    return project === undefined ? "New thread" : `New thread in ${project.name}`;
  }
  const thread = names.threads.find((candidate) => candidate.id === scope.threadId)?.displayTitle ?? "A thread";
  return scope.kind === "queued-message" ? `Queued message in ${thread}` : thread;
}

/**
 * Appends the card's prompt (`cardPrompt`) to the composer's draft and puts the
 * caret there, so the user can add to it. Throws what the handle throws — a
 * composer that closed since the menu was drawn is "no longer available".
 */
export function addCardToComposer(composer: Pick<PluginComposerApi, "insert" | "focus">, prompt: string): void {
  composer.insert(prompt, { at: "end", block: true });
  composer.focus();
}
