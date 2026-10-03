/**
 * Add to chat: what a card puts into a composer that is already on screen,
 * and what each such composer is called in the picker.
 *
 * The card goes in as one plain-text line — kind, `owner/name#number`, title
 * and the GitHub URL — on its own paragraph after whatever the draft already
 * holds. Never at the cursor: a cursor insert replaces selected text, and the
 * draft is the user's. Nothing is sent; the user reads it and sends it.
 *
 * Pure apart from the handle it is given, so it is tested with a fake one.
 */
import type { PluginComposerApi, PluginComposerScope } from "@get-bb/plugin-sdk/app";

import type { BoardItem, ColumnId } from "../shared/board";
import { kindLabel } from "./board-logic";

/** The board's card as one line of prompt text. */
export function cardReference(
  item: Pick<BoardItem, "repository" | "number" | "title" | "url">,
  column: ColumnId,
): string {
  // A title is one line on GitHub, but the line must stay one line whatever
  // the API hands back.
  const title = item.title.replace(/\s+/g, " ").trim();
  return `${kindLabel(column)} ${item.repository}#${item.number}: ${title} — ${item.url}`;
}

/** What the picker needs from bb's sidebar to name a composer. */
export interface ComposerNames {
  threads: readonly { id: string; displayTitle: string }[];
  projects: readonly { id: string; name: string }[];
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
 * Appends the card to the composer's draft and puts the caret there, so the
 * user can say what to do with it. Throws what the handle throws — a composer
 * that closed since the menu was drawn is "no longer available".
 */
export function addCardToComposer(
  composer: Pick<PluginComposerApi, "insert" | "focus">,
  item: Pick<BoardItem, "repository" | "number" | "title" | "url">,
  column: ColumnId,
): void {
  composer.insert(cardReference(item, column), { at: "end", block: true });
  composer.focus();
}
