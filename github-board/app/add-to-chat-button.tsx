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
 * What goes in is the prompt Send to chat would use, for the picked chat's
 * project (`cardPrompt`), so the menu's chats stay disabled until the
 * templates have loaded: there is no lesser text to fall back to.
 *
 * The board's own Send to chat dialog is never a target (see `chatTargets`).
 * The hooks live in this small component on purpose: `useComposers()`
 * re-renders its caller on every keystroke in any listed draft, and the
 * detail panel around it renders a whole body of Markdown.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposers,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { BoardItem, ColumnId, PromptSettings } from "../shared/board";
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
import { addCardToComposer, cardPrompt, chatTargets, type ChatTargets, type ThreadTarget } from "./add-to-chat";
import { pendingAdds } from "./pending-add";
import { errorText, useBoardRpc, usePrompts } from "./state";

const NO_PROJECTS: ReadonlySet<string> = new Set();

export function AddToChatControl({
  targets,
  loading,
  addingTo,
  prompts,
  promptsError,
  item,
  column,
  onOpenThread,
}: {
  targets: ChatTargets<PluginComposerApi>;
  /** The sidebar's thread list has not arrived yet. */
  loading: boolean;
  /** The thread an earlier pick is still waiting to open, which keeps the others from being picked. */
  addingTo: string | null;
  /** The prompt templates; null until they load, which keeps every chat from being picked. */
  prompts: PromptSettings | null;
  /** Why the templates did not load. */
  promptsError: string | null;
  item: BoardItem;
  column: ColumnId;
  onOpenThread(target: ThreadTarget, prompt: string): void;
}) {
  const add = (composer: PluginComposerApi, projectId: string | null) => {
    if (prompts === null) return;
    try {
      addCardToComposer(composer, cardPrompt(prompts, item, column, projectId));
    } catch (cause) {
      toast.error(`Could not add to chat: ${errorText(cause)}`);
    }
  };
  const openThread = (target: ThreadTarget) => {
    if (prompts !== null) onOpenThread(target, cardPrompt(prompts, item, column, target.projectId));
  };
  const { onScreen, threads } = targets;
  const waiting = prompts === null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" />
          Add to chat
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 max-w-80 overflow-y-auto">
        {waiting && (onScreen.length > 0 || threads.length > 0) ? (
          <p className={`px-2 py-1 text-xs ${promptsError === null ? "text-muted-foreground" : "text-destructive"}`}>
            {promptsError === null ? "Loading prompt templates…" : `Could not load prompt templates: ${promptsError}`}
          </p>
        ) : null}
        {onScreen.length > 0 ? (
          <>
            <DropdownMenuLabel>On screen</DropdownMenuLabel>
            {onScreen.map(({ composer, label, projectId }) => (
              <DropdownMenuItem
                key={composer.key}
                // A thread's project comes from the sidebar, so until it answers
                // that composer's project override is not known yet.
                disabled={waiting || (loading && composer.scope.kind !== "new-thread")}
                // A tick later: while the menu is open its focus trap would pull
                // the composer's focus straight back into the menu.
                onSelect={() => setTimeout(() => add(composer, projectId), 0)}
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
                disabled={waiting || addingTo !== null}
                onSelect={() => setTimeout(() => openThread(target), 0)}
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
  const navigate = useBbNavigate();
  const cardProjectIds = useCardProjectIds(item);
  const pending = useSyncExternalStore(pendingAdds.subscribe, pendingAdds.current, pendingAdds.current);
  // The same templates the Send to chat dialog reads, kept current by the same realtime push.
  const { prompts, error: promptsError } = usePrompts();
  const targets = useMemo(
    () => chatTargets({ composers, threads, projects, cardProjectIds, sendDialogOpen }),
    [composers, threads, projects, cardProjectIds, sendDialogOpen],
  );

  const openThread = (target: ThreadTarget, prompt: string) => {
    const held = pendingAdds.request({ threadId: target.threadId, title: target.title, prompt });
    // The menu disables this while another card waits; this is the backstop.
    if (held === null) return;
    navigate.toThread(target.threadId, { split: true });
  };

  return (
    <AddToChatControl
      targets={targets}
      loading={status === "loading"}
      addingTo={pending?.title ?? null}
      prompts={prompts}
      promptsError={promptsError}
      item={item}
      column={column}
      onOpenThread={openThread}
    />
  );
}
