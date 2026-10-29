/**
 * Moving between the open comment threads: the up and down arrows in the tab's toolbar and on each
 * thread, the palette's next/previous comment and Go to. The order is the tab's own, each thread where
 * its card is drawn (the whole diff's and the "Not on the current diff" ones at the top, then each
 * file's whole-file threads and its line threads by line); a step wraps around at either end, as the
 * palette's always has. It brings that place into view, marks the thread as the current one and moves
 * the keyboard focus to it. A thread whose file's diff has not loaded yet has no place until it does
 * (its line, or the top section when its lines are gone): a step to it loads that diff and lands once
 * the place is known.
 */
import { createContext, useContext } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { scrollWithin } from "./scroll-within";

/**
 * Where a thread's card is drawn: in the sections at the top of the tab (the whole diff's, and "Not on
 * the current diff"), under a file's header (a whole-file thread), or at a line; `pending` while its
 * file's diff, which decides between its line and the top, has not loaded (the card waits under the
 * file's header meanwhile).
 */
export type CommentPlace =
  | { kind: "top" }
  | { kind: "file"; path: string }
  | { kind: "line"; path: string; side: "old" | "new"; line: number }
  | { kind: "pending"; path: string };

/** A thread in the tab's order; only open ones are stepped to. */
export interface CommentOrderEntry {
  threadId: string;
  open: boolean;
}

/**
 * The open thread `delta` steps from `from` (a thread id, open or not), or without one the first
 * (next) or the last (previous) open thread; null when there is none to move to.
 */
export function stepTarget(order: readonly CommentOrderEntry[], delta: 1 | -1, from: string | null): string | null {
  const open = order.filter((entry) => entry.open);
  if (open.length === 0) return null;
  if (from === null) return open[delta > 0 ? 0 : open.length - 1]!.threadId;
  const at = order.findIndex((entry) => entry.threadId === from);
  if (at < 0) return null;
  for (let offset = 1; offset < order.length; offset++) {
    const entry = order[(((at + delta * offset) % order.length) + order.length) % order.length]!;
    if (entry.open && entry.threadId !== from) return entry.threadId;
  }
  return null;
}

export interface CommentNav {
  /** Steps to the previous or next open thread, from `from` or from the last step. */
  step(delta: 1 | -1, from?: string): void;
  /** Whether there is a thread to step to (from `from`: one other than it). */
  canStep(from?: string): boolean;
  /** The thread the last step went to, drawn marked: a focus ring shows only after keyboard use. */
  current: string | null;
}

/** Null where there is no stepping (the "Any file" view, whose palette commands are off too). */
export const CommentNavContext = createContext<CommentNav | null>(null);

function Arrow({ label, icon, disabled, onClick, className }: { label: string; icon: "ArrowUp" | "ArrowDown"; disabled: boolean; onClick(): void; className: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so its tooltip hangs on a wrapper. */}
        <span className="inline-flex">
          <Button type="button" variant="ghost" size="icon" className={className} aria-label={label} disabled={disabled} onClick={onClick}>
            <Icon name={icon} className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Whether `threadId` is the thread the last step went to. */
export function useIsCurrentComment(threadId: string): boolean {
  return useContext(CommentNavContext)?.current === threadId;
}

/** The up and down arrows; `from` makes them step from that thread rather than from the last step. */
export function CommentNavButtons({ from, className = "size-7" }: { from?: string; className?: string }) {
  const nav = useContext(CommentNavContext);
  if (nav === null) return null;
  const disabled = !nav.canStep(from);
  return (
    <TooltipProvider>
      <span className="inline-flex shrink-0 items-center" role="group" aria-label="Comments">
        <Arrow label="Previous comment" icon="ArrowUp" disabled={disabled} onClick={() => nav.step(-1, from)} className={className} />
        <Arrow label="Next comment" icon="ArrowDown" disabled={disabled} onClick={() => nav.step(1, from)} className={className} />
      </span>
    </TooltipProvider>
  );
}

/**
 * Moves the keyboard focus to a thread once it is drawn: a file's diff may still be mounting when the
 * step asks, so this looks again on the next frames. Once the card is there it waits two more frames,
 * past the reveal of its file or line (which scrolls in a frame of its own), then scrolls the tab's
 * own area, as little as shows the card, and focuses it without scrolling anything else.
 */
export function focusThread(root: HTMLElement | null, threadId: string, frames = 30): void {
  if (root === null) return;
  // Thread ids are hex, safe in a selector as they are.
  const card = root.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
  if (card === null) {
    if (frames > 0) requestAnimationFrame(() => focusThread(root, threadId, frames - 1));
    return;
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!card.isConnected) return;
      scrollWithin(root, card, "nearest");
      card.focus({ preventScroll: true });
    }),
  );
}
