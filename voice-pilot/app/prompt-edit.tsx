/**
 * The voice's staged edit of its own instructions, on the Voice page: what it changes as bb's own diff view
 * (the instructions now against the proposed ones), and Apply, Tweak (edit the proposed text, then apply it) and
 * Reject. Nothing is applied without one of these; the voice can only stage (`server/prompt-edits.ts`). The
 * read is live: the server invalidates it whenever the staged edit changes, so a new edit that replaces the
 * one on screen shows at once, with a note saying it replaced it.
 */
import { experimental_Diff as Diff, experimental_Icon as Icon, experimental_useRpcQuery as useRpcQuery, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";
import { changeCounts, promptContract, unifiedPatch, type StagedEdit } from "../shared/prompt-edit";
import { NEXT_SESSION_NOTE, stagedNotes, stagedWhen } from "./prompt-edit-view";

const DIFF_PATH = "voice-pilot-instructions.md";

/** The staged edit and the instructions in force, read live; `staged` is null when nothing waits. */
export function useStagedEdit(): { staged: StagedEdit | null; current: string | null; error: string | null; refetch: () => Promise<void> } {
  const read = useRpcQuery({ contract: promptContract, method: "prompt.staged", input: {} });
  return { staged: read.data?.staged ?? null, current: read.data?.current ?? null, error: read.error?.message ?? null, refetch: read.refetch };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PromptEditCard() {
  const rpc = useRpc<typeof rpcContract>();
  const { staged, current, error: readError, refetch } = useStagedEdit();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const shownId = useRef<string | null>(null);

  // A new edit that replaces the one being reviewed (or tweaked) starts the review over, and says so.
  useEffect(() => {
    const id = staged?.id ?? null;
    if (shownId.current !== null && id !== null && id !== shownId.current) {
      setSwapped(draft !== null);
      setDraft(null);
      setFailed(null);
    }
    if (id !== null) setDone(null);
    shownId.current = id;
  }, [staged?.id]);

  if (staged === null || current === null) {
    if (readError !== null) return <p className="px-4 py-2 text-xs text-destructive">Could not read the staged instructions edit: {readError}</p>;
    return done === null ? null : <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{done}</p>;
  }

  const act = async (run: () => Promise<unknown>, after: string) => {
    setBusy(true);
    setFailed(null);
    try {
      await run();
      setDraft(null);
      setSwapped(false);
      setDone(after);
      // The server invalidates the read too; reading now does not wait for that to arrive.
      await refetch().catch(() => undefined);
    } catch (error) {
      setFailed(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const after = draft ?? staged.proposed;
  const patch = unifiedPatch(current, after, DIFF_PATH);
  const counts = changeCounts(current, after);

  return (
    <section aria-label="Proposed instructions edit" className="flex max-h-[55%] min-h-0 flex-col gap-2 overflow-y-auto border-b border-warning bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Edit" className="text-warning-text" />
        <span className="text-sm font-semibold">Proposed instructions edit</span>
        <span className="text-xs text-muted-foreground">
          {stagedWhen(staged.stagedAt)} · {counts.added} added, {counts.removed} removed
        </span>
      </div>
      <p className="m-0 text-sm">{staged.summary}</p>
      {swapped && <p className="m-0 text-xs text-warning-text">A newer edit replaced the one you were tweaking; your tweak was set aside. This is the new one.</p>}
      {stagedNotes(staged, current).map((note) => (
        <p key={note} className="m-0 text-xs text-warning-text">
          {note}
        </p>
      ))}
      {draft !== null && (
        <textarea
          aria-label="Tweak the proposed instructions"
          className="min-h-48 w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {patch === "" ? (
        <p className="m-0 text-xs text-muted-foreground">No change from the instructions now.</p>
      ) : (
        <Diff patch={patch} path={DIFF_PATH} overflow="wrap" className="rounded-md border border-border" />
      )}
      <p className="m-0 text-xs text-muted-foreground">{NEXT_SESSION_NOTE}</p>
      {failed !== null && <p className="m-0 text-xs text-destructive">{failed}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {draft === null ? (
          <>
            <Button type="button" size="sm" disabled={busy} onClick={() => void act(() => rpc.call("prompt.apply", { id: staged.id }), "Applied. The next voice session starts with the new instructions.")}>
              Apply
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDraft(staged.proposed)}>
              Tweak
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act(() => rpc.call("prompt.reject", { id: staged.id }), "Rejected. The instructions stay as they were.")}>
              Reject
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy || draft.trim() === ""}
              onClick={() => void act(() => rpc.call("prompt.apply", { id: staged.id, text: draft }), "Applied your tweak. The next voice session starts with it.")}
            >
              Apply tweak
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
