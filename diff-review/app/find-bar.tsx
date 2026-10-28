/**
 * The find bar under the toolbar: a plain-text search across the diff's loaded lines (`find.ts`), the
 * match count, previous/next (Enter, Shift+Enter) and match case. Escape closes it.
 */
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function FindBar({
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  count,
  current,
  truncated,
  loading,
  onStep,
  onClose,
  focusKey,
}: {
  query: string;
  onQuery(query: string): void;
  caseSensitive: boolean;
  onCaseSensitive(next: boolean): void;
  count: number;
  /** Index of the current match, or -1. */
  current: number;
  truncated: boolean;
  /** Some files' diffs are still loading, so the count may grow. */
  loading: boolean;
  onStep(delta: 1 | -1): void;
  onClose(): void;
  /** Changes when the bar is asked for again, to focus its field. */
  focusKey: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);
  const status = query === "" ? "" : count === 0 ? (loading ? "Searching…" : "No matches") : `${current + 1} of ${count}${truncated ? "+" : ""}${loading ? " so far" : ""}`;
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5" role="search">
      <Icon name="Search" className="size-3.5 text-muted-foreground" />
      <input
        ref={input}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in the diff"
        aria-label="Find in the diff"
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
        {status}
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5 text-xs" aria-pressed={caseSensitive} onClick={() => onCaseSensitive(!caseSensitive)} aria-label="Match case">
        Aa
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" disabled={count === 0} onClick={() => onStep(-1)} aria-label="Previous match">
        <Icon name="ChevronUp" className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" disabled={count === 0} onClick={() => onStep(1)} aria-label="Next match">
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" onClick={onClose} aria-label="Close find">
        <Icon name="X" className="size-3.5" />
      </Button>
    </div>
  );
}
