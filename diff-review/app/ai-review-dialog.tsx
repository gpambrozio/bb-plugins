/**
 * "AI review": diffity's focus chips (any number, or none for every pass), the user's own instructions,
 * and the agent to run it, which leaves its comments in the tab as it goes.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import type { RpcContract } from "../shared/contract";
import { BODY_MAX_CHARS, REVIEW_FOCUSES, type Run } from "../shared/types";
import { ExecutionPicker, useRunDefaults } from "./execution-picker";
import { errorMessage } from "./use-review";

export function AiReviewDialog({
  open,
  onOpenChange,
  sessionId,
  threadId,
  environmentId,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessionId: string;
  threadId: string;
  environmentId: string;
  onStarted(run: Run): void;
}) {
  const rpc = useRpc<RpcContract>();
  const defaults = useRunDefaults(threadId, open);
  const [focuses, setFocuses] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = (focus: string) =>
    setFocuses((previous) => (previous.includes(focus) ? previous.filter((item) => item !== focus) : [...previous, focus]));

  const start = async () => {
    if (defaults.execution === null) return;
    setBusy(true);
    try {
      const { run } = await rpc.call("startReview", { sessionId, threadId, focuses, instructions, execution: defaults.execution });
      if (run.status === "failed") toast.error(run.summary ?? "The review could not start.");
      else toast.success("AI review started; its comments appear here as it goes.");
      onStarted(run);
      setFocuses([]);
      setInstructions("");
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not start the review: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>AI review</DialogTitle>
          <DialogDescription>An agent reviews this diff in a thread of its own and leaves comments here.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Focus (none: every pass)</span>
            <div className="flex flex-wrap gap-1.5">
              {REVIEW_FOCUSES.map((focus) => (
                <Button key={focus} type="button" size="sm" variant={focuses.includes(focus) ? "default" : "outline"} aria-pressed={focuses.includes(focus)} onClick={() => toggle(focus)}>
                  {focus}
                </Button>
              ))}
            </div>
          </div>
          <Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Anything else to look at (optional)" maxLength={BODY_MAX_CHARS} rows={3} />
          <ExecutionPicker environmentId={environmentId} execution={defaults.execution} onChange={defaults.setExecution} message={defaults.message} permissionMode={defaults.permissionMode} disabled={busy} />
          <p className="text-xs text-muted-foreground">
            It is asked not to edit files, but bb cannot stop it; any file that changes while it runs is listed on the run.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void start()} disabled={busy || defaults.execution === null}>
            {busy ? "Starting…" : "Start review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
