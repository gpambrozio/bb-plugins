/**
 * Add to chat: puts the card into a chat that is already on screen — a thread
 * open beside the board, a new-thread composer, a queued message being edited
 * — without starting a thread or sending anything.
 *
 * Absent while no composer is on screen. With one, a press adds the card to
 * it; with several, a menu names each (oldest first, bb's order) and the user
 * picks. The hooks live in this small component on purpose: `useComposers()`
 * re-renders its caller on every keystroke in any listed draft, and the
 * detail panel around it renders a whole body of Markdown.
 */
import {
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { addCardToComposer, composerLabel, type ComposerNames } from "./add-to-chat";
import { errorText } from "./state";

export function AddToChatControl({
  composers,
  names,
  item,
  column,
}: {
  composers: readonly PluginComposerApi[];
  names: ComposerNames;
  item: BoardItem;
  column: ColumnId;
}) {
  if (composers.length === 0) return null;

  const add = (composer: PluginComposerApi) => {
    try {
      addCardToComposer(composer, item, column);
    } catch (cause) {
      toast.error(`Could not add to chat: ${errorText(cause)}`);
    }
  };
  const content = (
    <>
      <Icon name="Plus" />
      Add to chat
    </>
  );

  const only = composers.length === 1 ? composers[0] : undefined;
  if (only !== undefined) {
    return (
      <Button
        size="sm"
        variant="outline"
        aria-label={`Add to chat: ${composerLabel(only.scope, names)}`}
        onClick={() => add(only)}
      >
        {content}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          {content}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel>Add to which chat?</DropdownMenuLabel>
        {composers.map((composer) => (
          <DropdownMenuItem
            key={composer.key}
            // A tick later: while the menu is open its focus trap would pull
            // the composer's focus straight back into the menu.
            onSelect={() => setTimeout(() => add(composer), 0)}
          >
            <span className="truncate">{composerLabel(composer.scope, names)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AddToChatButton({ item, column }: { item: BoardItem; column: ColumnId }) {
  const composers = useComposers();
  const { threads, projects } = experimental_useSidebarThreads();
  return <AddToChatControl composers={composers} names={{ threads, projects }} item={item} column={column} />;
}
