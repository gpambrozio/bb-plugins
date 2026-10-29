/**
 * The Files view ("Any file" in the view picker): any file of the working tree, in the diff or not.
 * Search the workspace by path, open a file, and comment on its lines with the gutter "+" or on the
 * whole file, as in the diff; the comments are sent to the agent the same way. A thread keeps the
 * text of its lines and is found again by it when the file changes. Files with comments are listed
 * first. Diffity's Files tab, on bb's file reads (whichever machine holds the workspace).
 */
import { File as PierreFile, type LineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import { experimental_useCodeTheme, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { placeThread, type Placement } from "../shared/anchors";
import type { RpcContract } from "../shared/contract";
import { contentLines, linesText } from "../shared/patch-lines";
import type { ReviewThread, WorkspaceFile } from "../shared/types";
import { useActions } from "./actions";
import { ANNOTATION_FIT } from "./annotation-fit";
import { CommentComposer } from "./comment-composer";
import { changedSince, currentLines, LineDraftBox, OrphanDrafts, type LineRange } from "./file-diff";
import { COLOR_BLIND_SETTING, paletteStyle } from "./palette";
import { ThreadCard } from "./thread-card";
import { errorMessage } from "./use-review";
import { draftKeys, useDraft, useDraftKeys } from "./view-state";

type Annotation = { kind: "threads"; threads: { thread: ReviewThread; placement: Placement }[] } | { kind: "draft"; range: LineRange };

/** `refreshKey` changes with every load of the view (Reload, a workspace change): the open file is read again. */
export function FilesView({ threadId, threads, refreshKey }: { threadId: string; threads: readonly ReviewThread[]; refreshKey: number }) {
  const rpc = useRpc<RpcContract>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Files with comments or an unsent one come first, so a draft is never hidden; a search lists
  // matches below them.
  const draftKeyList = useDraftKeys();
  const commented = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) if (thread.filePath !== "__general__") counts.set(thread.filePath, (counts.get(thread.filePath) ?? 0) + 1);
    for (const key of draftKeyList) if (key.startsWith("file:") || key.startsWith("line:")) counts.set(key.slice("file:".length), counts.get(key.slice("file:".length)) ?? 0);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [threads, draftKeyList]);

  useEffect(() => {
    if (query.trim() === "") {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      rpc.call("searchFiles", { threadId, query: query.trim() }).then(
        (found) => live && setResults(found),
        () => live && setResults({ paths: [], truncated: false }),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, threadId, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a file in the workspace"
          aria-label="Find a file"
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <ul className="flex max-h-48 flex-col overflow-y-auto" aria-label="Files">
          {commented.map(([path, count]) => (
            <FileRow key={`c:${path}`} path={path} detail={count === 0 ? "unsent comment" : `${count} comment thread${count === 1 ? "" : "s"}`} current={open === path} onOpen={setOpen} />
          ))}
          {results?.paths
            .filter((path) => !commented.some(([done]) => done === path))
            .map((path) => <FileRow key={`r:${path}`} path={path} current={open === path} onOpen={setOpen} />)}
          {results !== null && results.paths.length === 0 ? <li className="px-2 py-1 text-xs text-muted-foreground">No file matches.</li> : null}
          {results === null && commented.length === 0 ? <li className="px-2 py-1 text-xs text-muted-foreground">Search for a file to comment on it.</li> : null}
        </ul>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{open === null ? null : <OpenFile key={open} threadId={threadId} path={open} refreshKey={refreshKey} threads={threads.filter((thread) => thread.filePath === open)} />}</div>
    </div>
  );
}

function FileRow({ path, detail, current, onOpen }: { path: string; detail?: string; current: boolean; onOpen(path: string): void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover ${current ? "bg-state-active" : ""}`}
        onClick={() => onOpen(path)}
      >
        <span className="min-w-0 truncate font-mono text-xs">{path}</span>
        {detail === undefined ? null : <span className="ml-auto shrink-0 text-xs text-muted-foreground">{detail}</span>}
      </button>
    </li>
  );
}

function OpenFile({ threadId, path, threads, refreshKey }: { threadId: string; path: string; threads: readonly ReviewThread[]; refreshKey: number }) {
  const rpc = useRpc<RpcContract>();
  const actions = useActions();
  const codeTheme = experimental_useCodeTheme();
  const settings = useSettings();
  const palette = paletteStyle(settings.values?.[COLOR_BLIND_SETTING] === true, codeTheme.mode);
  const [file, setFile] = useState<WorkspaceFile | { error: string } | null>(null);
  const lineDraft = useDraft(draftKeys.line(path));
  const lineDraftRef = useRef(lineDraft);
  lineDraftRef.current = lineDraft;
  const fileDraft = useDraft(draftKeys.file(path));
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);

  // Read on open and again on every load of the view; the text on screen stays until the new read
  // lands, and drafts and the selection stay as they are.
  useEffect(() => {
    let live = true;
    rpc.call("readFile", { threadId, path }).then(
      (read) => live && setFile(read),
      (error: unknown) => live && setFile({ error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId, path, refreshKey]);

  const content = file !== null && "content" in file ? file.content : null;
  const lines = useMemo(() => (content === null ? undefined : contentLines(content)), [content]);
  const placed = useMemo(() => threads.filter((thread) => thread.startLine > 0).map((thread) => ({ thread, placement: placeThread(thread, lines) })), [threads, lines]);
  const wholeFile = threads.filter((thread) => thread.startLine === 0);
  const lost = placed.filter(({ placement }) => placement.state === "outdated").map(({ thread }) => thread);
  const draft = lineDraft.active?.range ?? null;

  const annotations = useMemo(() => {
    const byLine = new Map<number, LineAnnotation<Annotation>>();
    for (const entry of placed) {
      if (entry.placement.state === "outdated") continue;
      const existing = byLine.get(entry.placement.endLine);
      if (existing !== undefined && existing.metadata.kind === "threads") existing.metadata.threads.push(entry);
      else byLine.set(entry.placement.endLine, { lineNumber: entry.placement.endLine, metadata: { kind: "threads", threads: [entry] } });
    }
    const list = [...byLine.values()];
    if (draft !== null) list.push({ lineNumber: draft.endLine, metadata: { kind: "draft", range: draft } });
    return list;
  }, [placed, draft]);

  const options = useMemo(
    () => ({
      theme: codeTheme.name,
      themeType: codeTheme.mode,
      overflow: "wrap" as const,
      disableFileHeader: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      onLineSelected: (range: SelectedLineRange | null) => setSelected(range),
      onGutterUtilityClick: (range: SelectedLineRange) => {
        lineDraftRef.current.open({ range: { side: "new", startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) } });
        setSelected(null);
      },
    }),
    [codeTheme.name, codeTheme.mode],
  );

  const revision = file !== null && "revision" in file ? file.revision : null;
  const fileState = { revision: revision ?? "" };

  if (file === null) return <p className="px-3 py-2 text-xs text-muted-foreground">Loading {path}…</p>;
  if ("error" in file)
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-xs text-destructive">Could not open {path}: {file.error}</p>
        <OrphanDrafts path={path} note="This file could not be read." />
      </div>
    );

  return (
    <section className="flex flex-col" data-file-path={path}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-xs"
          onClick={() => void actions.explain({ filePath: path, side: null, startLine: 0, endLine: 0, code: null }).catch(() => undefined)}
          aria-label={`Explain ${path}`}
        >
          <Icon name="Bot" className="size-3.5" />
          Explain
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs" onClick={() => fileDraft.open()}>
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment on file
        </Button>
      </header>
      {wholeFile.length > 0 || lost.length > 0 || fileDraft.active !== null ? (
        <div className="flex flex-col gap-2 px-3 py-2">
          {wholeFile.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} fileChanged={changedSince(thread, fileState)} />
          ))}
          {lost.map((thread) => (
            <div key={thread.id} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Its lines are no longer in the file:</span>
              <ThreadCard thread={thread} placement={{ state: "outdated" }} />
            </div>
          ))}
          {fileDraft.active !== null ? (
            <CommentComposer
              placeholder="A comment about the whole file"
              submitLabel="Comment"
              withSeverity
              initialBody={fileDraft.latest().body}
              initialSeverity={fileDraft.latest().severity}
              onChange={fileDraft.change}
              onSubmit={async ({ body, severity }) => {
                await actions.create({ filePath: path, side: null, startLine: 0, endLine: 0, anchorContent: null, body, severity, fileRevision: revision });
                fileDraft.close();
              }}
              onCancel={fileDraft.close}
            />
          ) : null}
        </div>
      ) : null}
      {content === null ? (
        <div className="flex flex-col gap-2 px-3 py-2">
          <p className="text-xs text-muted-foreground">{file.reason}</p>
          {draft === null ? null : <LineDraftBox filePath={path} fileRevision={revision} range={draft} draft={lineDraft} note="This file has no lines to show." anchorContent={null} />}
        </div>
      ) : (
        <div style={palette}>
          <PierreFile<Annotation>
            file={{ name: path, contents: content }}
            options={options}
            lineAnnotations={annotations}
            selectedLines={selected}
            renderAnnotation={(annotation) => (
              <div className={ANNOTATION_FIT} data-annotation-fit="">
                {annotation.metadata.kind === "threads" ? (
                  <div className="flex flex-col gap-2 px-3 py-2">
                    {annotation.metadata.threads.map(({ thread, placement }) => (
                      <ThreadCard key={thread.id} thread={thread} placement={placement} fileChanged={changedSince(thread, fileState)} current={currentLines(thread, placement, lines)} />
                    ))}
                  </div>
                ) : (
                  <LineDraftBox
                    filePath={path}
                    fileRevision={revision}
                    range={annotation.metadata.range}
                    draft={lineDraft}
                    note={null}
                    anchorContent={lines === undefined ? null : linesText(lines, "new", annotation.metadata.range.startLine, annotation.metadata.range.endLine)}
                  />
                )}
              </div>
            )}
          />
        </div>
      )}
    </section>
  );
}
