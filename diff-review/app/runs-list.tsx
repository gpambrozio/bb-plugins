/**
 * The session's AI runs not yet closed, under the toolbar: what each is, where it stands, a link to its
 * thread, and Close, which archives that thread. A review run that ended with files changed in the
 * workspace says which.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import { describeLocation, type ReviewThread, type Run } from "../shared/types";
import { errorMessage } from "./use-review";

const STATUS_LABELS: Record<Run["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  closed: "closed",
};

export function runTitle(run: Run, threads: readonly ReviewThread[]): string {
  if (run.kind === "review") return run.focus === null ? "AI review" : `AI review · ${run.focus}`;
  if (run.kind === "fix") return "Fixes in a new thread";
  const thread = threads.find((row) => row.id === run.reviewThreadId);
  return thread === undefined ? "Answer to a mention" : `Answer on ${describeLocation(thread)}`;
}

function RunRow({ run, threads, onClosed }: { run: Run; threads: readonly ReviewThread[]; onClosed(run: Run): void }) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [closing, setClosing] = useState(false);
  const changed = run.changedFiles ?? [];

  const close = async () => {
    setClosing(true);
    try {
      await rpc.call("closeRun", { runId: run.id });
      onClosed({ ...run, status: "closed" });
    } catch (error) {
      toast.error(`Could not close the run: ${errorMessage(error)}`);
    } finally {
      setClosing(false);
    }
  };

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2" data-run-id={run.id}>
      <div className="flex items-center gap-2 text-sm">
        <Icon name={run.status === "running" ? "Spinner" : run.status === "failed" ? "AlertTriangle" : "Bot"} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{runTitle(run, threads)}</span>
        <span className={cn("shrink-0 text-xs", run.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{STATUS_LABELS[run.status]}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {run.threadId === null ? null : (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate.toThread(run.threadId!)}>
              Open thread
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void close()} disabled={closing}>
            Close
          </Button>
        </span>
      </div>
      {run.kind === "review" && changed.length > 0 ? (
        <p className="text-xs text-warning-text">
          Files changed in this workspace while it ran: {changed.join(", ")}
        </p>
      ) : null}
      {run.status === "failed" && run.summary !== null ? <p className="text-xs text-muted-foreground">{run.summary}</p> : null}
    </li>
  );
}

export function RunsList({ runs, threads, onClosed }: { runs: readonly Run[]; threads: readonly ReviewThread[]; onClosed(run: Run): void }) {
  if (runs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 border-b border-border px-3 py-2" aria-label="AI runs">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} threads={threads} onClosed={onClosed} />
      ))}
    </ul>
  );
}
