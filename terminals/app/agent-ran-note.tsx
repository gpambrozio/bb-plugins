/**
 * The card over a terminal listing every command the tab's agent chat typed
 * there: the last three, newest last, and a control to show them all.
 * Expanded, it grows up to a quarter of the terminal's height and scrolls
 * beyond that. Set apart from the terminal's text by bb's accent
 * (`timeline-accent`, in both themes) and an opaque card. It stays for the
 * whole chat, so it folds down to a pill (`folded`, which the page remembers
 * per tab) to leave the terminal clear.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import type { AgentTypedNote } from "./agent-state";

/** How many commands the note shows folded. */
export const FOLDED_COMMANDS = 3;

export function AgentRanNote({
  commands,
  folded,
  onFold,
}: {
  commands: readonly AgentTypedNote[];
  folded: boolean;
  onFold: (folded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const more = commands.length > FOLDED_COMMANDS;
  // Shows three again when the list goes down to three or fewer (a new chat).
  useEffect(() => {
    if (!more) setExpanded(false);
  }, [more]);
  const shown = expanded ? commands : commands.slice(-FOLDED_COMMANDS);
  // The newest is last: keep it in view when the expanded list scrolls.
  useLayoutEffect(() => {
    const element = list.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [expanded, commands.length]);
  if (commands.length === 0) return null;
  if (folded) {
    return (
      <button
        type="button"
        data-agent-ran=""
        aria-label={`Show the commands the agent ran (${commands.length})`}
        className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-full border border-timeline-accent/50 bg-background px-2 py-0.5 text-xs font-medium text-foreground shadow-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onFold(false)}
      >
        <Icon name="Bot" className="shrink-0 text-timeline-accent" aria-hidden />
        {commands.length}
      </button>
    );
  }
  return (
    <div
      role="status"
      aria-label="Commands the agent ran"
      data-agent-ran=""
      className="absolute right-3 top-2 z-10 flex max-h-[25%] w-max min-w-0 max-w-[min(40rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-md border border-timeline-accent/50 border-l-4 border-l-timeline-accent bg-background text-xs text-foreground shadow-md"
    >
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-1.5">
        <Icon name="Bot" className="shrink-0 text-timeline-accent" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">
          {commands.length === 1 ? "The agent ran" : `The agent ran ${commands.length} commands`}
        </span>
        {more ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-0.5 h-5 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show all ${commands.length}`}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-0.5 -mr-1 h-5 shrink-0 px-1 text-muted-foreground hover:text-foreground"
          aria-label="Fold the list to a small button"
          onClick={() => onFold(true)}
        >
          <Icon name="ChevronUp" />
        </Button>
      </div>
      <ol ref={list} className="min-h-0 overflow-y-auto px-2 pb-1.5 pt-1" aria-label="Commands, oldest first">
        {shown.map((note, index) => (
          <li key={`${note.at}-${index}`} className="flex min-w-0 items-baseline gap-1.5 py-px">
            <span className="shrink-0 text-timeline-accent" aria-hidden>
              $
            </span>
            <code className="min-w-0 truncate font-mono" title={note.command}>
              {note.command}
            </code>
          </li>
        ))}
      </ol>
    </div>
  );
}
