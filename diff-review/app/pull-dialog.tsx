/** "A pull request…" in the view picker: paste a GitHub pull request's address to review it here. */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { parsePullUrl, pullText, type PullRef } from "../shared/github";

export function PullDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange(open: boolean): void; onPick(ref: PullRef): void }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const ref = parsePullUrl(text);
  const pick = () => {
    if (ref === null) return;
    onOpenChange(false);
    onPick(ref);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review a pull request</DialogTitle>
          <DialogDescription>
            Its changes are fetched into this workspace's repository, without switching your checkout, and its review threads come from GitHub through the GitHub
            CLI on the bb server's machine.
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
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request"
          className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {text.trim() !== "" && ref === null ? <p className="text-xs text-destructive">Paste the pull request's address on github.com.</p> : null}
        {ref === null ? null : <p className="text-xs text-muted-foreground">Reviews {pullText(ref)}.</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={pick} disabled={ref === null}>
            Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
