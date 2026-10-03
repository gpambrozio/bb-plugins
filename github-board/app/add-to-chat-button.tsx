/**
 * Add to chat: puts the card into a chat's draft — a thread open beside the
 * board, a new-thread composer, a queued message being edited, or any recent
 * thread — without starting a thread or sending anything.
 *
 * Always there, as a menu: the chats on screen first, then recent threads,
 * the card's own projects' first. A chat on screen gets the card at once. A
 * thread that is not on screen is opened (beside the board where bb can split
 * the window, in its place where it cannot) and gets the card once its
 * composer appears, which the app overlay sees to (`pending-add.ts`). One such
 * card at a time: until it lands, the other threads are disabled with the
 * reason, while the chats on screen still take a card at once.
 *
 * The board's own Send to chat dialog is never a target (see `chatTargets`).
 * The hooks live in this small component on purpose: `useComposers()`
 * re-renders its caller on every keystroke in any listed draft, and the
 * detail panel around it renders a whole body of Markdown.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useComposers,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { BoardItem, ColumnId } from "../shared/board";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { addCardToComposer, chatTargets, type ChatTargets, type ThreadTarget } from "./add-to-chat";
import { pendingAdds } from "./pending-add";
import { errorText, useBoardRpc } from "./state";

const NO_PROJECTS: ReadonlySet<string> = new Set();

export function AddToChatControl({
  targets,
  loading,
  addingTo,
  item,
  column,
  onOpenThread,
}: {
  targets: ChatTargets<PluginComposerApi>;
  /** The sidebar's thread list has not arrived yet. */
  loading: boolean;
  /** The thread an earlier pick is still waiting to open, which keeps the others from being picked. */
  addingTo: string | null;
  item: BoardItem;
  column: ColumnId;
  onOpenThread(target: ThreadTarget): void;
}) {
  const add = (composer: PluginComposerApi) => {
    try {
      addCardToComposer(composer, item, column);
    } catch (cause) {
      toast.error(`Could not add to chat: ${errorText(cause)}`);
    }
  };
  const { onScreen, threads } = targets;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" />
          Add to chat
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 max-w-80 overflow-y-auto">
        {onScreen.length > 0 ? (
          <>
            <DropdownMenuLabel>On screen</DropdownMenuLabel>
            {onScreen.map(({ composer, label }) => (
              <DropdownMenuItem
                key={composer.key}
                // A tick later: while the menu is open its focus trap would pull
                // the composer's focus straight back into the menu.
                onSelect={() => setTimeout(() => add(composer), 0)}
              >
                <span className="truncate">{label}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {onScreen.length > 0 && (threads.length > 0 || loading) ? <DropdownMenuSeparator /> : null}
        {threads.length > 0 ? (
          <>
            <DropdownMenuLabel>Open a thread and add</DropdownMenuLabel>
            {addingTo === null ? null : (
              <p className="px-2 pb-1 text-xs text-muted-foreground">Adding to {addingTo}…</p>
            )}
            {threads.map((target) => (
              <DropdownMenuItem
                key={target.threadId}
                disabled={addingTo !== null}
                onSelect={() => setTimeout(() => onOpenThread(target), 0)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{target.title}</span>
                  {target.projectName === null ? null : (
                    <span className="truncate text-xs text-muted-foreground">{target.projectName}</span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : loading ? (
          <DropdownMenuItem disabled>Loading threads…</DropdownMenuItem>
        ) : onScreen.length === 0 ? (
          <DropdownMenuItem disabled>No threads to add to</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The bb projects whose checkout is the card's repository, so their threads lead the menu. */
function useCardProjectIds(item: BoardItem): ReadonlySet<string> {
  const rpc = useBoardRpc();
  const [ids, setIds] = useState<ReadonlySet<string>>(NO_PROJECTS);
  useEffect(() => {
    let live = true;
    rpc.call("sendOptions", { repository: item.repository, url: item.url }).then(
      ({ candidates }) => {
        if (live) setIds(new Set(candidates.map((candidate) => candidate.id)));
      },
      // Only the order depends on it: without it, recent threads lead.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, item.repository, item.url]);
  return ids;
}

export function AddToChatButton({
  item,
  column,
  sendDialogOpen,
}: {
  item: BoardItem;
  column: ColumnId;
  /** The board's Send to chat dialog is open, so its composer is on screen. */
  sendDialogOpen: boolean;
}) {
  const composers = useComposers();
  const { status, threads, projects } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const cardProjectIds = useCardProjectIds(item);
  const pending = useSyncExternalStore(pendingAdds.subscribe, pendingAdds.current, pendingAdds.current);
  const targets = useMemo(
    () => chatTargets({ composers, threads, projects, cardProjectIds, sendDialogOpen }),
    [composers, threads, projects, cardProjectIds, sendDialogOpen],
  );

  const openThread = (target: ThreadTarget) => {
    const { repository, number, title, url } = item;
    const held = pendingAdds.request({
      threadId: target.threadId,
      title: target.title,
      item: { repository, number, title, url },
      column,
    });
    // The menu disables this while another card waits; this is the backstop.
    if (held === null) return;
    actions.open(target.threadId, { split: true });
  };

  return (
    <AddToChatControl
      targets={targets}
      loading={status === "loading"}
      addingTo={pending?.title ?? null}
      item={item}
      column={column}
      onOpenThread={openThread}
    />
  );
}
