/**
 * One card. A press opens the detail panel; right-click opens the label menu.
 *
 * On a wide layout **Send to chat** — and **Update branch**, where the viewer can
 * use it — sit in the card's bottom-right corner and appear on hover or keyboard
 * focus, over the footer, so revealing them never reflows the card. They take
 * clicks only while the card is hovered or focused: on a touch screen nothing
 * hovers, and a tap on that corner must open the card rather than push a
 * commit nobody could see the button for. There the panel's buttons are the
 * way. On a compact layout they are an ordinary row under the card instead.
 */
import type { KeyboardEvent } from "react";

import type { BoardItem, ColumnId } from "../shared/board";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { relativeTime } from "./board-logic";
import { LabelMenu } from "./label-menu";
import { ItemPills } from "./pills";

export interface CardActions {
  onOpen(item: BoardItem, column: ColumnId): void;
  onSend(item: BoardItem, column: ColumnId): void;
  onUpdateBranch(item: BoardItem): void;
}

export function Card({
  item,
  column,
  viewerLogin,
  selected,
  updating,
  updateError,
  compact,
  actions,
}: {
  item: BoardItem;
  column: ColumnId;
  viewerLogin: string;
  selected: boolean;
  updating: boolean;
  /** Why the last update failed, shown under the footer until the next try. */
  updateError: string | null;
  compact: boolean;
  actions: CardActions;
}) {
  const canUpdate = item.branch?.canUpdate === true;
  const open = () => actions.onOpen(item, column);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const updateButton = (
    <Button
      size="sm"
      variant={compact ? "outline" : "secondary"}
      disabled={updating}
      onClick={(event) => {
        event.stopPropagation();
        actions.onUpdateBranch(item);
      }}
    >
      {updating ? "Updating…" : "Update branch"}
    </Button>
  );
  const sendButton = (
    <Button
      size="sm"
      onClick={(event) => {
        event.stopPropagation();
        actions.onSend(item, column);
      }}
    >
      <Icon name="MessageSquarePlus" />
      Send to chat
    </Button>
  );

  return (
    <LabelMenu item={item} enabled={column !== "discussions"}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${item.repository}#${item.number}: ${item.title}`}
        onClick={open}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative cursor-pointer rounded-md border bg-card p-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          selected ? "border-primary" : "border-border",
        )}
      >
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">
            {item.repository}#{item.number}
          </span>
          <span className="shrink-0">· {relativeTime(item.updatedAt)}</span>
          {item.commentsCount > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Icon name="MessageSquare" className="size-3" />
              {item.commentsCount}
            </span>
          ) : null}
        </div>
        <p className={cn("mt-1 text-sm font-medium text-foreground", compact ? "line-clamp-2" : "line-clamp-3")}>
          {item.title}
        </p>
        {item.author !== null && item.author.toLowerCase() !== viewerLogin.toLowerCase() ? (
          <p className="mt-0.5 text-xs text-muted-foreground">by {item.author}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <ItemPills item={item} />
          {item.detail !== null ? <span className="text-[11px] text-muted-foreground">{item.detail}</span> : null}
        </div>
        {updateError !== null ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {updateError}
          </p>
        ) : null}

        {compact ? (
          <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
            {canUpdate ? updateButton : null}
            {sendButton}
          </div>
        ) : (
          <div className="pointer-events-none absolute right-2 bottom-2 flex gap-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            {canUpdate ? updateButton : null}
            {sendButton}
          </div>
        )}
      </div>
    </LabelMenu>
  );
}
