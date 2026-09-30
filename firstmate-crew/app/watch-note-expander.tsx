/**
 * Watch notes that expand in the chat. The first mate's watch messages show the captain one line and a
 * "full note" chip (`server/watch-delivery.ts`); bb gives a plugin no way to draw inside a user message,
 * so this app-wide overlay listens for clicks on those chips, keeps bb from opening the note as a file,
 * and portals the note, read back into its runs, just below the chip's line. A chip whose message leaves
 * the page takes its expanded note with it.
 */
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { rpcContract } from "../server";
import type { WatchNote } from "../shared/types";
import { CHIP_RESOURCE_ATTRIBUTE, codeBlock, keepLineBreaks, watchNoteFile } from "./watch-note-format";

interface Expanded {
  /** Unique per expansion: the same note's chip can show in two panes at once. */
  key: number;
  chip: Element;
  file: string;
  container: HTMLElement;
}

let nextKey = 1;

function open(chip: Element, file: string): Expanded {
  const container = document.createElement("div");
  // Marked as the plugin's, so its stylesheet applies here as it does in its own panels.
  container.setAttribute("data-bb-plugin", "firstmate-crew");
  (chip.closest("p, li, div") ?? chip).after(container);
  chip.setAttribute("aria-expanded", "true");
  return { key: nextKey++, chip, file, container };
}

function close(entry: Expanded): void {
  entry.container.remove();
  entry.chip.setAttribute("aria-expanded", "false");
}

export function WatchNoteExpander() {
  const [expanded, setExpanded] = useState<Expanded[]>([]);
  const current = useRef(expanded);
  current.current = expanded;

  useEffect(() => {
    function onClick(event: MouseEvent): void {
      const chip = event.target instanceof Element ? event.target.closest(`[${CHIP_RESOURCE_ATTRIBUTE}]`) : null;
      if (chip === null) return;
      const file = watchNoteFile(chip.getAttribute(CHIP_RESOURCE_ATTRIBUTE));
      if (file === null) return;
      // Ours: bb would open the note in the file panel.
      event.preventDefault();
      event.stopPropagation();
      const shown = current.current.find((entry) => entry.chip === chip);
      if (shown === undefined) {
        setExpanded([...current.current, open(chip, file)]);
      } else {
        close(shown);
        setExpanded(current.current.filter((entry) => entry !== shown));
      }
    }

    // A message bb re-renders or scrolls away leaves its chip detached; its note goes with it.
    const observer = new MutationObserver(() => {
      const gone = current.current.filter((entry) => !entry.chip.isConnected);
      if (gone.length === 0) return;
      gone.forEach((entry) => entry.container.remove());
      setExpanded(current.current.filter((entry) => !gone.includes(entry)));
    });

    document.addEventListener("click", onClick, true);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("click", onClick, true);
      observer.disconnect();
      current.current.forEach(close);
    };
  }, []);

  return <>{expanded.map((entry) => createPortal(<WatchNoteView file={entry.file} />, entry.container, entry.key))}</>;
}

function ranAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function WatchNoteView({ file }: { file: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState<WatchNote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpc
      .call("watch.note", { file })
      .then((loaded) => live && setNote(loaded))
      .catch((failure: unknown) => live && setError(failure instanceof Error ? failure.message : String(failure)));
    return () => {
      live = false;
    };
  }, [rpc, file]);

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-background p-3 text-left text-sm text-foreground">
      {error !== null ? <div className="text-destructive">{error}</div> : null}
      {error === null && note === null ? <div className="text-muted-foreground">Loading the note…</div> : null}
      {note !== null && note.dropped > 0 ? (
        <div className="text-xs text-muted-foreground">
          {note.dropped} older {note.dropped === 1 ? "note was" : "notes were"} dropped before this one.
        </div>
      ) : null}
      {note?.runs.map((run, index) => (
        <section key={index} className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-muted-foreground">
            {run.name} · {ranAt(run.ran)}
            {run.failed !== null ? <span className="text-destructive"> · failed: {run.failed}</span> : null}
          </div>
          <Markdown content={run.failed !== null ? codeBlock(run.text) : keepLineBreaks(run.text)} />
        </section>
      ))}
    </div>
  );
}
