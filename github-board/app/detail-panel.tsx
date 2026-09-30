/**
 * One card, opened: what the card already had, then what the search never
 * fetched — the body, live state, dates, assignees and branches — and the
 * comments on request.
 *
 * On a wide layout it is the right-hand part of the board's body, over a
 * blurred scrim that closes it when pressed; its left edge drags to resize, and
 * the width is saved as a share of the body so it fits a different window. On
 * compact it is the whole body and Close is the way back.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";

import type { BoardItem, ColumnId, ItemComment, ItemDetails } from "../shared/board";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { absoluteDate, behindSentence, kindLabel, relativeTime, stateLabel, staleBranch } from "./board-logic";
import { isOpenableLink } from "./link";
import { MarkdownBody } from "./markdown";
import { ItemPills } from "./pills";
import { RemoteImage } from "./remote-image";
import { errorText, useBoardRpc } from "./state";

const DEFAULT_FRACTION = 0.5;
/** The narrowest the panel gets, and the least board it leaves showing. */
const DETAIL_MIN_WIDTH = 320;
const BOARD_MIN_WIDTH = 260;

function clampWidth(width: number, bodyWidth: number): number {
  const max = Math.max(DETAIL_MIN_WIDTH, bodyWidth - BOARD_MIN_WIDTH);
  return Math.min(Math.max(width, DETAIL_MIN_WIDTH), max);
}

// Keyed by URL, so an image replaced in a refreshed body starts over — and an
// external image approved for one host is never loaded for another.
const renderImage = (image: { url: string; alt: string }) => (
  <RemoteImage key={image.url} url={image.url} alt={image.alt} />
);

function Comments({ id, force }: { id: string; force: number }) {
  const rpc = useBoardRpc();
  const [result, setResult] = useState<{ comments: ItemComment[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    rpc.call("loadComments", { id, force: force > 0 }).then(
      (value) => {
        if (live) setResult(value);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, id, force]);

  if (error !== null) return <p className="text-sm text-destructive">{error}</p>;
  if (result === null) return <p className="text-sm text-muted-foreground">Loading comments…</p>;
  if (result.comments.length === 0) return <p className="text-sm text-muted-foreground">No comments.</p>;
  return (
    <div className="space-y-3">
      {result.comments.map((comment) => (
        <div key={comment.id} className={cn("rounded-md border border-border p-2.5", comment.depth > 0 && "ml-6")}>
          <p className="mb-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{comment.author ?? "ghost"}</span> ·{" "}
            {relativeTime(comment.createdAt)}
          </p>
          <MarkdownBody source={comment.body} renderImage={renderImage} />
        </div>
      ))}
      {result.truncated ? (
        <p className="text-xs text-muted-foreground">The rest of the conversation is on GitHub.</p>
      ) : null}
    </div>
  );
}

export function DetailPanel({
  item,
  column,
  compact,
  bodyWidth,
  widthFraction,
  updating,
  updateError,
  onWidthCommitted,
  onClose,
  onSend,
  onUpdateBranch,
}: {
  item: BoardItem;
  column: ColumnId;
  compact: boolean;
  /** The board body's width, for the resize clamp; unused on compact. */
  bodyWidth: number;
  widthFraction: number | null;
  updating: boolean;
  updateError: string | null;
  onWidthCommitted(fraction: number): void;
  onClose(): void;
  onSend(): void;
  onUpdateBranch(): void;
}) {
  const rpc = useBoardRpc();
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [commentsRequested, setCommentsRequested] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    rpc.call("loadItem", { id: item.id, force: refreshes > 0 }).then(
      (value) => {
        if (live) setDetails(value);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, item.id, refreshes]);

  // The drag runs on component state and is saved once, on release — a save
  // per move would be a write per pixel. A share saved elsewhere is adopted,
  // but never mid-drag, which would yank the edge from under the pointer.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const width = clampWidth(dragWidth ?? bodyWidth * (widthFraction ?? DEFAULT_FRACTION), bodyWidth);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Captured, so a pointer that outruns the handle across the board, or
    // leaves the window, still moves the edge and still reports the release.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, width };
    setDragWidth(width);
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return;
    // Anchored right, so a drag left grows it.
    const next = clampWidth(drag.current.startWidth - (event.clientX - drag.current.startX), bodyWidth);
    drag.current.width = next;
    setDragWidth(next);
  };
  const onResizeEnd = () => {
    if (drag.current === null) return;
    // The ref, not state: the last move may not have rendered yet.
    const final = drag.current.width;
    drag.current = null;
    if (bodyWidth > 0) onWidthCommitted(Math.min(1, final / bodyWidth));
    setDragWidth(null);
  };

  const branch = staleBranch(item.branch);
  const openable = isOpenableLink(item.url);

  const panel = (
    <aside
      className={cn(
        "flex h-full flex-col bg-background",
        compact ? "w-full" : "absolute top-0 right-0 bottom-0 border-l border-border shadow-lg",
        // Always present, so it plays once on mount and a resize never replays it.
        !compact && "animate-in slide-in-from-right duration-200",
      )}
      style={compact ? undefined : { width }}
      aria-label={`${kindLabel(column)} ${item.repository}#${item.number}`}
    >
      {compact ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel"
          className="absolute top-0 bottom-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none select-none hover:bg-primary/20"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onLostPointerCapture={onResizeEnd}
        />
      )}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {kindLabel(column)}
          {details !== null ? ` · ${stateLabel(details.state)}` : ""}
        </span>
        <div className="flex-1" />
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Refresh"
          onClick={() => {
            setRefreshes((count) => count + 1);
          }}
        >
          <Icon name="RefreshCw" />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Close" onClick={onClose}>
          <Icon name="X" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
          <p className="text-xs text-muted-foreground">
            {item.repository}#{item.number}
            {item.author !== null ? ` · opened by ${item.author}` : ""}
            {details !== null && details.createdAt !== "" ? ` on ${absoluteDate(details.createdAt)}` : ""}
          </p>
          {details?.branches != null ? (
            <p className="font-mono text-xs text-muted-foreground">
              {details.branches.head} → {details.branches.base}
              {branch !== null ? <span className="font-sans"> · {behindSentence(branch)}</span> : null}
            </p>
          ) : null}
          {details !== null && details.assignees.length > 0 ? (
            <p className="text-xs text-muted-foreground">Assigned to {details.assignees.join(", ")}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <ItemPills item={item} allLabels />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onSend}>
            <Icon name="MessageSquarePlus" />
            Send to chat
          </Button>
          {item.branch?.canUpdate === true ? (
            <Button size="sm" variant="outline" disabled={updating} onClick={onUpdateBranch}>
              {updating ? "Updating…" : "Update branch"}
            </Button>
          ) : null}
          {openable ? (
            <Button size="sm" variant="outline" asChild>
              <UrlLink href={item.url}>
                <Icon name="ExternalLink" />
                Open on GitHub
              </UrlLink>
            </Button>
          ) : null}
        </div>

        {updateError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {updateError}
          </p>
        ) : null}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        {details === null && error === null ? (
          <div className="space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : null}
        {details !== null ? (
          details.body.trim() === "" ? (
            <p className="text-sm text-muted-foreground italic">No description provided.</p>
          ) : (
            <MarkdownBody source={details.body} renderImage={renderImage} />
          )
        ) : null}

        <div className="border-t border-border pt-4">
          {commentsRequested ? (
            <Comments id={item.id} force={refreshes} />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setCommentsRequested(true)}>
              {item.commentsCount === 0 ? "Load comments" : `Load ${item.commentsCount} comments`}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );

  if (compact) return <div className="absolute inset-0 z-20">{panel}</div>;
  return (
    <div className="absolute inset-0 z-20">
      <button
        type="button"
        aria-label="Close the panel"
        className="absolute inset-0 cursor-default bg-background/50 backdrop-blur-[3px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      {panel}
    </div>
  );
}
