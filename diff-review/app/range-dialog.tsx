/**
 * "A range…" in the view picker: two revisions, `a..b` or `a...b` as git takes them (an empty side is
 * `HEAD`). `a...b` shows what b changed since it forked from a, even once merged.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { parseRange, rangeText, type HostDiffSpec } from "../shared/git-spec";

export function RangeDialog({
  open,
  onOpenChange,
  initial,
  onPick,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial: string;
  onPick(range: Extract<HostDiffSpec, { kind: "range" }>): void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);
  const range = parseRange(text);
  const pick = () => {
    if (range === null) return;
    onOpenChange(false);
    onPick(range);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review a range</DialogTitle>
          <DialogDescription>
            Two revisions as git takes them: <code>main..feature</code> diffs from their merge base, and <code>main...feature</code> shows what feature changed
            since it forked, even once merged.
          </DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              pick();
            }
          }}
          placeholder="main...HEAD"
          aria-label="Range"
          className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {text.trim() !== "" && range === null ? <p className="text-xs text-destructive">Write it as a..b or a...b, with branch names, tags or SHAs.</p> : null}
        {range === null ? null : <p className="text-xs text-muted-foreground">Reviews {rangeText(range)}.</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={pick} disabled={range === null}>
            Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
