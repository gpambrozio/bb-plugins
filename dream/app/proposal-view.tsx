/**
 * A waiting dry run's proposal: the counts, then every memory file the dream would add, change or
 * delete, as a line diff against the memory as it is now (MEMORY.md included), with Apply and
 * Discard. Viewing reads only; Apply and Discard are the same calls the project card makes. When a
 * file the dream changed has changed in the memory since the dry run, the view says so and Apply
 * is off, because the server refuses it then.
 */
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import { changeText, when } from "../shared/format";
import { lineDiff } from "../shared/line-diff";
import type { ProposalDiff, ProposalFile } from "../shared/types";
import { DanglingLinks } from "./dangling-links";
import { errorText } from "./use-dream";

const KIND_TEXT: Record<ProposalFile["kind"], string> = { added: "Added", changed: "Changed", deleted: "Deleted" };

function FileDiff({ file }: { file: ProposalFile }) {
  const rows = lineDiff(file.current, file.proposed);
  return (
    <section className="rounded-md border border-border">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className={cn("rounded-full border px-2 py-0.5 text-xs", file.kind === "deleted" ? "border-destructive text-destructive" : file.kind === "added" ? "border-success text-success" : "border-border text-muted-foreground")}>
          {KIND_TEXT[file.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        {file.baseChanged ? <span className="text-xs text-warning-text">changed in the memory since the dry run</span> : null}
      </header>
      <div className="overflow-x-auto py-1 font-mono text-xs" role="table" aria-label={`Changes to ${file.path}`}>
        {rows.length === 0 ? <p className="px-3 py-1 text-muted-foreground">No line changes.</p> : null}
        {rows.map((row, index) =>
          row.kind === "skip" ? (
            <div key={index} className="bg-state-hover px-3 py-0.5 text-muted-foreground" role="row">
              … {row.count} unchanged {row.count === 1 ? "line" : "lines"}
            </div>
          ) : (
            <div
              key={index}
              role="row"
              data-kind={row.kind}
              className={cn("flex whitespace-pre px-3", row.kind === "add" && "text-success", row.kind === "del" && "text-destructive")}
            >
              <span className="w-4 shrink-0 select-none">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
              <span>{row.text}</span>
            </div>
          ),
        )}
        {file.truncated ? <p className="px-3 py-1 text-muted-foreground">The file is too long to show in full; this is its beginning.</p> : null}
      </div>
    </section>
  );
}

export function ProposalView({ projectId, projectName, busy, onClose, onChanged }: { projectId: string; projectName: string; busy: boolean; onClose(): void; onChanged(): void }) {
  const rpc = useRpc<RpcContract>();
  const [proposal, setProposal] = useState<ProposalDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(() => {
    rpc
      .call("proposal", { projectId })
      .then((next) => {
        setProposal(next);
        setError(null);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [rpc, projectId]);

  useEffect(load, [load]);

  async function act(label: string, work: () => Promise<string>) {
    setWorking(true);
    try {
      toast.success(await work());
      onChanged();
      onClose();
    } catch (caught) {
      toast.error(`${label}: ${errorText(caught)}`);
      load();
    } finally {
      setWorking(false);
    }
  }

  const stale = proposal?.files.filter((file) => file.baseChanged).map((file) => file.path) ?? [];

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <Icon name="ChevronLeft" />
          Projects
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Dry run for {projectName}
          {proposal ? <span className="font-normal text-muted-foreground"> · {when(proposal.createdAt)}</span> : null}
        </h2>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {proposal === null && error === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {proposal ? (
        <>
          <p className="text-sm">
            Would {changeText(proposal.changes, true).toLowerCase()}: {proposal.changes.changed.length} changed, {proposal.changes.added.length} added,{" "}
            {proposal.changes.deleted.length} deleted.
          </p>
          {stale.length > 0 ? (
            <div className="rounded-md border border-warning px-3 py-2 text-sm text-warning-text" role="alert">
              The memory has changed since this dry run: {stale.join(", ")}. Applying it would undo those changes, so Apply is off. Discard it and dream
              again.
            </div>
          ) : null}
          <DanglingLinks links={proposal.danglingLinks} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={working || busy || stale.length > 0}
              onClick={() =>
                void act("Apply", async () => {
                  const result = await rpc.call("apply", { projectId, stamp: proposal.stamp });
                  return `Applied to ${projectName}: ${changeText(result.changes)}.`;
                })
              }
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={working || busy}
              onClick={() =>
                void act("Discard", async () => {
                  await rpc.call("discard", { projectId, stamp: proposal.stamp });
                  return `Discarded the dry run for ${projectName}.`;
                })
              }
            >
              Discard
            </Button>
          </div>
          {proposal.summary ? (
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm">The dream's summary</summary>
              <Markdown content={proposal.summary} className="mt-2 text-sm" />
            </details>
          ) : null}
          {proposal.files.map((file) => (
            <FileDiff key={file.path} file={file} />
          ))}
        </>
      ) : null}
    </div>
  );
}
