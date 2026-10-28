/**
 * "Revert…" on a file of the uncommitted view: put back the whole file as committed, or only the
 * hunks picked. It asks first, since the uncommitted change it undoes is gone afterwards.
 */
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { parseHunks } from "../shared/revert";
import type { DiffFile } from "../shared/types";
import { useActions } from "./actions";

export function RevertDialog({ file, open, onOpenChange }: { file: DiffFile; open: boolean; onOpenChange(open: boolean): void }) {
  const actions = useActions();
  const hunks = useMemo(() => (file.patch === null || file.binary ? [] : parseHunks(file.patch)), [file.patch, file.binary]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setChosen(new Set(hunks.map((_, index) => index)));
  }, [open, hunks]);
  const whole = hunks.length === 0 || chosen.size === hunks.length;
  const revert = async () => {
    setBusy(true);
    try {
      await actions.revert(file, whole ? null : [...chosen].sort((a, b) => a - b));
      onOpenChange(false);
    } catch {
      // The toast said why.
    } finally {
      setBusy(false);
    }
  };
  const what = file.changeKind === "added" ? "Delete this new file" : whole ? "Revert the whole file to its last commit" : `Revert ${chosen.size} of ${hunks.length} changes`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Revert {file.path}?</DialogTitle>
          <DialogDescription>This undoes uncommitted changes in the workspace. It cannot be undone here.</DialogDescription>
        </DialogHeader>
        {hunks.length > 1 && file.changeKind !== "added" ? (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label="Changes">
            {hunks.map((hunk, index) => (
              <li key={index}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-state-hover">
                  <Checkbox
                    checked={chosen.has(index)}
                    onCheckedChange={(checked) =>
                      setChosen((previous) => {
                        const next = new Set(previous);
                        if (checked === true) next.add(index);
                        else next.delete(index);
                        return next;
                      })
                    }
                    aria-label={`Change at line ${hunk.newStart}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs text-muted-foreground">{hunk.header}</span>
                    <span className="block truncate font-mono text-xs">{hunk.newLines.find((line, offset) => line !== hunk.oldLines[offset]) ?? hunk.oldLines[0] ?? ""}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void revert()} disabled={busy || (!whole && chosen.size === 0) || chosen.size === 0 && hunks.length > 0}>
            {what}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
