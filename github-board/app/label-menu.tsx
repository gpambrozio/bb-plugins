/**
 * The repository's labels as a menu of toggles, opened by right-clicking an
 * issue or pull request card (or a long press on touch).
 *
 * Each press is one call, applied at once, and the row waits for GitHub's
 * answer rather than moving optimistically — the answer is the item's labels
 * after the change, so someone else's edit lands on the card instead of being
 * overwritten. A failure is shown inside the menu, which stays open: it belongs
 * to the label just pressed, not to the board.
 */
import { useEffect, useState, type ReactNode } from "react";

import type { BoardItem, RepositoryLabel } from "../shared/board";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { labelColor } from "./board-logic";
import { errorText, patchBoardItem, useBoardRpc } from "./state";

/** Label sets change far more slowly than the work they are put on. */
const LABELS_TTL_MS = 5 * 60_000;
const cachedLabels = new Map<string, { labels: RepositoryLabel[]; storedAt: number }>();

function LabelMenuContent({ item }: { item: BoardItem }) {
  const rpc = useBoardRpc();
  const hit = cachedLabels.get(item.repository);
  const [labels, setLabels] = useState<RepositoryLabel[] | null>(
    hit !== undefined && Date.now() - hit.storedAt < LABELS_TTL_MS ? hit.labels : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (labels !== null) return;
    let live = true;
    rpc.call("listLabels", { repository: item.repository }).then(
      (result) => {
        cachedLabels.set(item.repository, { labels: result.labels, storedAt: Date.now() });
        if (live) setLabels(result.labels);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, item.repository, labels]);

  function toggle(label: RepositoryLabel, add: boolean) {
    if (pending !== null) return;
    setPending(label.id);
    setError(null);
    rpc.call("toggleLabel", { itemId: item.id, labelId: label.id, add }).then(
      (result) => {
        patchBoardItem(item.id, { labels: result.labels });
        setPending(null);
      },
      (cause: unknown) => {
        setError(errorText(cause));
        setPending(null);
      },
    );
  }

  return (
    <ContextMenuContent className="max-h-[300px] w-[260px] overflow-y-auto">
      <ContextMenuLabel className="truncate">Labels · {item.repository}</ContextMenuLabel>
      <ContextMenuSeparator />
      {error !== null ? <p className="px-2 py-1.5 text-xs text-destructive">{error}</p> : null}
      {labels === null && error === null ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading labels…</p>
      ) : null}
      {labels !== null && labels.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">This repository has no labels.</p>
      ) : null}
      {labels?.map((label) => {
        const checked = item.labels.includes(label.name);
        const color = labelColor(label.color);
        return (
          <ContextMenuCheckboxItem
            key={label.id}
            checked={checked}
            disabled={pending !== null && pending !== label.id}
            className={pending === label.id ? "opacity-50" : undefined}
            onSelect={(event) => {
              // Stays open, so several labels can be set in one visit.
              event.preventDefault();
              toggle(label, !checked);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full border border-border"
                style={color === null ? undefined : { backgroundColor: color }}
              />
              <span className="truncate" title={label.description ?? undefined}>
                {label.name}
              </span>
            </span>
          </ContextMenuCheckboxItem>
        );
      })}
    </ContextMenuContent>
  );
}

/**
 * Wraps a card in the menu. Discussions get none: GitHub would label them, but
 * they are not work whose labels a reader acts on.
 */
export function LabelMenu({
  item,
  enabled,
  children,
}: {
  item: BoardItem;
  enabled: boolean;
  children: ReactNode;
}) {
  // The content is mounted only while open, so a board of cards asks for no
  // labels until one menu is actually opened.
  const [open, setOpen] = useState(false);
  if (!enabled) return <>{children}</>;
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open ? <LabelMenuContent item={item} /> : null}
    </ContextMenu>
  );
}
