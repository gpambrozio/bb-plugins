/**
 * "Go to": one list of the view's files, its open comment threads and the views the picker offers,
 * filtered as you type; Enter or a click goes there. It stands in for diffity's ⌘P (files) and ⌘K
 * (comments, commits): bb keeps Mod+P and Mod+K for its own quick open and search.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface GoToEntry {
  key: string;
  group: "File" | "Comment" | "View";
  label: string;
  detail?: string;
  go(): void;
  /** Where the focus goes after the dialog closes (a comment's card). */
  focus?(): void;
}

/** Entries whose label or detail holds every word of `query`, case-insensitive, in their order. */
export function filterEntries(entries: readonly GoToEntry[], query: string): GoToEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.group} ${entry.label} ${entry.detail ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function GoToDialog({ open, onOpenChange, entries }: { open: boolean; onOpenChange(open: boolean): void; entries: readonly GoToEntry[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);
  const shown = useMemo(() => filterEntries(entries, query).slice(0, 200), [entries, query]);
  // A pick's `focus` runs once the closing dialog has put the focus back, which would undo it sooner.
  const picked = useRef<GoToEntry | null>(null);
  const go = (entry: GoToEntry | undefined) => {
    if (entry === undefined) return;
    picked.current = entry;
    onOpenChange(false);
    entry.go();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onAfterCloseAutoFocus={() => {
          picked.current?.focus?.();
          picked.current = null;
        }}
      >
        <DialogHeader>
          <DialogTitle>Go to</DialogTitle>
          <DialogDescription>A file, an open comment or a view of this review.</DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, shown.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(shown[active]);
            }
          }}
          placeholder="Type to filter"
          aria-label="Filter"
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <ul className="flex max-h-80 flex-col overflow-y-auto" role="listbox" aria-label="Places">
          {shown.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">Nothing matches.</li> : null}
          {shown.map((entry, index) => (
            <li key={entry.key} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-state-hover ${index === active ? "bg-state-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(entry)}
              >
                <span className="w-16 shrink-0 text-xs text-muted-foreground">{entry.group}</span>
                <span className="min-w-0 truncate">{entry.label}</span>
                {entry.detail === undefined ? null : <span className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">{entry.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
