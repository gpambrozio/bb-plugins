/**
 * Palette commands for the Review tab's actions. A command runs outside the tab (bb hands it only the
 * thread in view and its side panel), so it opens the thread's Review tab and leaves the action here
 * for that tab: a showing tab of the thread takes it at once, otherwise the tab takes it when it shows.
 * An action no tab takes within a few seconds is dropped, so a stale one never fires later.
 */
import { useEffect, useRef } from "react";

export const REVIEW_COMMANDS = {
  reload: "reload the diff",
  send: "send comments to the agent",
  "ai-review": "start an AI review",
  "comment-diff": "comment on the whole diff",
  find: "find in the diff",
  "go-to": "go to a file, comment or view…",
  "next-comment": "next comment",
  "previous-comment": "previous comment",
  "toggle-style": "switch between split and unified",
  "toggle-only-commented": "show only files with comments, or all",
  "toggle-whitespace": "hide or show whitespace changes",
  clear: "clear the review…",
} as const;

export type ReviewCommand = keyof typeof REVIEW_COMMANDS;

/** How long an action waits for its tab to show, in milliseconds. */
export const PENDING_MS = 5_000;

type Handler = (command: ReviewCommand) => void;

const handlers = new Map<string, Set<Handler>>();
const pending = new Map<string, { command: ReviewCommand; at: number }>();

/** Hands `command` to `threadId`'s showing Review tab, or keeps it for the tab about to show. */
export function dispatchReviewCommand(threadId: string, command: ReviewCommand, now = Date.now()): void {
  const listening = handlers.get(threadId);
  if (listening !== undefined && listening.size > 0) {
    for (const handler of listening) handler(command);
    return;
  }
  pending.set(threadId, { command, at: now });
}

/** Takes the commands for `threadId` while `visible`, including one left for it just before it showed. */
export function useReviewCommands(threadId: string, visible: boolean, handler: Handler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!visible) return;
    const own: Handler = (command) => handlerRef.current(command);
    const set = handlers.get(threadId) ?? new Set();
    set.add(own);
    handlers.set(threadId, set);
    const waiting = pending.get(threadId);
    pending.delete(threadId);
    if (waiting !== undefined && Date.now() - waiting.at <= PENDING_MS) own(waiting.command);
    return () => {
      set.delete(own);
      if (set.size === 0) handlers.delete(threadId);
    };
  }, [threadId, visible]);
}

/** For tests: forgets every handler and pending command. */
export function forgetReviewCommands(): void {
  handlers.clear();
  pending.clear();
}
