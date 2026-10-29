/**
 * The reviews no live thread can open any more: every thread of their workspace archived and the
 * workspace gone, so the Reviews page does not list them. The page says how many there are and
 * deletes them, with all their comments, only after the user confirms. Nothing deletes them unasked.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { RpcContract } from "../shared/contract";
import type { OrphanReview } from "../shared/types";
import { useOrphanReviews } from "./reviews";
import { errorMessage } from "./use-review";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "3 reviews with 8 comment threads (7 open)". */
export function orphanText(orphans: readonly OrphanReview[]): string {
  const open = orphans.reduce((sum, orphan) => sum + orphan.openCount, 0);
  const total = orphans.reduce((sum, orphan) => sum + orphan.totalCount, 0);
  return `${plural(orphans.length, "review")} with ${plural(total, "comment thread")} (${open === 0 ? "all closed" : `${open} open`})`;
}

/** Under the list: how many reviews of archived workspaces there are, and Delete…; nothing when none. */
export function OrphanReviews() {
  const { data } = useOrphanReviews();
  const [confirming, setConfirming] = useState(false);
  if (data === undefined || data.length === 0) return null;
  return (
    <div className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
      <span className="min-w-0">
        Not listed: {orphanText(data)}, in workspaces that are gone. No thread can open {data.length === 1 ? "it" : "them"} any more.
      </span>
      <Button type="button" variant="outline" size="sm" className="ml-auto h-6 shrink-0 px-2 text-xs" onClick={() => setConfirming(true)}>
        Delete…
      </Button>
      <DeleteOrphansDialog open={confirming} onOpenChange={setConfirming} orphans={data} />
    </div>
  );
}

function DeleteOrphansDialog({ open, onOpenChange, orphans }: { open: boolean; onOpenChange(open: boolean): void; orphans: readonly OrphanReview[] }) {
  const rpc = useRpc<RpcContract>();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const { deleted } = await rpc.call("deleteOrphanReviews", { sessionIds: orphans.map((orphan) => orphan.sessionId) });
      // One a thread can open again by now is kept: the server checks each one again.
      if (deleted === orphans.length) toast.success(`Deleted ${plural(deleted, "review")}.`);
      else toast.info(`Deleted ${plural(deleted, "review")}; ${orphans.length - deleted} can be opened again, so ${orphans.length - deleted === 1 ? "it stays" : "they stay"}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not delete the reviews: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete reviews no thread can open?</DialogTitle>
          <DialogDescription>
            This deletes {orphanText(orphans)}, yours and the AI's, open or closed. Their threads are archived and their workspaces are gone. It can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy}>
            {busy ? "Deleting…" : "Delete reviews"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
