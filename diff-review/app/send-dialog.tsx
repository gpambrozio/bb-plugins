/**
 * "Send to agent": pick open threads, add an overall note, and send them to the thread under review —
 * or to a new thread in the same workspace, with the agent picked here.
 * Threads still waiting on an earlier send start unticked, so a second send does not repeat them.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import type { RpcContract } from "../shared/contract";
import { BODY_MAX_CHARS, describeLocation, type ReviewThread, type Run } from "../shared/types";
import { ExecutionPicker, useRunDefaults } from "./execution-picker";
import { SEVERITY_LABELS } from "./labels";
import { errorMessage } from "./use-review";

export function defaultSelection(threads: readonly ReviewThread[]): Set<string> {
  return new Set(threads.filter((thread) => thread.delivery?.state !== "sent").map((thread) => thread.id));
}

type Fixer = "this" | "new";

export function SendDialog({
  open,
  onOpenChange,
  sessionId,
  threadId,
  environmentId,
  threads,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessionId: string;
  threadId: string;
  environmentId: string;
  /** The session's open threads. */
  threads: readonly ReviewThread[];
  /** A new thread was started for the fixes. */
  onStarted(run: Run): void;
}) {
  const rpc = useRpc<RpcContract>();
  const [chosen, setChosen] = useState<Set<string>>(() => defaultSelection(threads));
  const [note, setNote] = useState("");
  const [fixer, setFixer] = useState<Fixer>("this");
  const [busy, setBusy] = useState(false);
  const defaults = useRunDefaults(threadId, open && fixer === "new");

  // Each opening starts from the threads as they are then, sending to this thread; a thread that
  // changes while the dialog is open keeps the tick the user gave it.
  useEffect(() => {
    if (!open) return;
    setChosen(defaultSelection(threads));
    setFixer("this");
  }, [open]);

  const toggle = (id: string, on: boolean) => {
    setChosen((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const ids = threads.filter((thread) => chosen.has(thread.id)).map((thread) => thread.id);

  const send = async () => {
    setBusy(true);
    try {
      if (fixer === "this") {
        const result = await rpc.call("send", { sessionId, threadId, reviewThreadIds: ids, note });
        const what = `${result.count} comment thread${result.count === 1 ? "" : "s"}`;
        toast.success(result.delivery === "queued" ? `Queued ${what} behind the agent's current turn` : `Sent ${what} to the agent`);
      } else {
        if (defaults.execution === null) return;
        const { run, count } = await rpc.call("fixInNewThread", { sessionId, reviewThreadIds: ids, note, execution: defaults.execution });
        if (run.status === "failed") {
          toast.error(run.summary ?? "The new thread could not start.");
        } else {
          toast.success(`Started a new thread with ${count} comment thread${count === 1 ? "" : "s"}`);
        }
        onStarted(run);
      }
      setNote("");
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not send: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to an agent</DialogTitle>
          <DialogDescription>The agent gets the comments, fixes what they ask for, and answers each one here.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Who fixes them">
          <Button type="button" size="sm" variant={fixer === "this" ? "default" : "outline"} role="radio" aria-checked={fixer === "this"} onClick={() => setFixer("this")}>
            This thread
          </Button>
          <Button type="button" size="sm" variant={fixer === "new" ? "default" : "outline"} role="radio" aria-checked={fixer === "new"} onClick={() => setFixer("new")}>
            A new thread…
          </Button>
        </div>
        {fixer === "new" ? (
          <ExecutionPicker environmentId={environmentId} execution={defaults.execution} onChange={defaults.setExecution} message={defaults.message} disabled={busy} />
        ) : null}
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {threads.map((thread) => (
            <label key={thread.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-state-hover">
              <Checkbox checked={chosen.has(thread.id)} onCheckedChange={(value) => toggle(thread.id, value === true)} className="mt-0.5" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {describeLocation(thread)}
                  {thread.severity === null ? "" : ` · ${SEVERITY_LABELS[thread.severity]}`}
                  {thread.delivery?.state === "sent" ? " · already sent" : ""}
                </span>
                <span className="truncate text-sm">{thread.comments[0]?.body ?? ""}</span>
              </span>
            </label>
          ))}
        </div>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="An overall note for the agent (optional)" maxLength={BODY_MAX_CHARS} rows={3} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void send()} disabled={busy || ids.length === 0 || (fixer === "new" && defaults.execution === null)}>
            {busy ? "Sending…" : fixer === "this" ? `Send ${ids.length}` : `Start a thread with ${ids.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
