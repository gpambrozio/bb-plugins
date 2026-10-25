/**
 * "Clear review": deletes every comment thread of the view and closes its AI runs, archiving their
 * threads, after the user confirms. Nothing of it can be brought back.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { RpcContract } from "../shared/contract";
import { errorMessage } from "./use-review";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function ClearReviewDialog({
  open,
  onOpenChange,
  sessionId,
  threadCount,
  runCount,
  onCleared,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessionId: string;
  threadCount: number;
  runCount: number;
  onCleared(): void;
}) {
  const rpc = useRpc<RpcContract>();
  const [busy, setBusy] = useState(false);

  const clear = async () => {
    setBusy(true);
    try {
      await rpc.call("clearReview", { sessionId });
      toast.success("The review is cleared.");
      onCleared();
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not clear the review: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const parts = [threadCount > 0 ? `deletes ${plural(threadCount, "comment thread")} in this view, yours and the AI's, open or closed` : null];
  if (runCount > 0) parts.push(`closes ${plural(runCount, "AI run")}, archiving ${runCount === 1 ? "its thread" : "their threads"} in bb`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clear this review?</DialogTitle>
          <DialogDescription>
            This {parts.filter((part) => part !== null).join(", and ")}. It can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void clear()} disabled={busy}>
            {busy ? "Clearing…" : "Clear review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
