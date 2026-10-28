/**
 * One changed file: its header (with "Comment on file" and how many comment threads it has), its whole-file threads, and the patch drawn
 * by the `@pierre/diffs` bb provides, with each line thread as an annotation under its last line. The
 * gutter "+" (or a dragged line selection, then "+") opens a new comment there.
 *
 * Pierre's line ranges carry a side for each end; a thread has one side, so a selection that crosses
 * from removed to added lines keeps only its first line.
 */
import { PatchDiff, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import { experimental_useCodeTheme, useSettings } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";

import { placeThread, type Placement } from "../shared/anchors";
import { linesText, parsePatchLines } from "../shared/patch-lines";
import { describeLocation, type DiffFile, type ReviewThread, type Side } from "../shared/types";
import { useActions } from "./actions";
import { ANNOTATION_FIT } from "./annotation-fit";
import { COLOR_BLIND_SETTING, paletteStyle } from "./palette";
import { useNearScreen, type PatchState } from "./patch-loader";
import { CommentComposer } from "./comment-composer";
import { ThreadCard } from "./thread-card";
import { draftKeys, useDraft, useViewState } from "./view-state";

export type DiffStyle = "split" | "unified";

/** Files with more changed lines than this start folded, so one huge file does not stall the tab. */
const FOLD_ABOVE_LINES = 2_000;

type Annotation =
  | { kind: "threads"; threads: { thread: ReviewThread; placement: Placement }[] }
  | { kind: "draft"; side: Side; startLine: number; endLine: number };

interface LineRange {
  side: Side;
  startLine: number;
  endLine: number;
}

function toSide(side: SelectedLineRange["side"]): Side {
  return side === "deletions" ? "old" : "new";
}

function toPierreSide(side: Side): "deletions" | "additions" {
  return side === "old" ? "deletions" : "additions";
}

/** A Pierre range as a thread's place: one side, start before end. */
export function draftFrom(range: SelectedLineRange): LineRange {
  const side = toSide(range.side);
  if (range.endSide !== undefined && range.endSide !== range.side) return { side, startLine: range.start, endLine: range.start };
  return { side, startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) };
}

/** The threads of a file placed against its current patch, split into line threads and the rest. */
export function placeFileThreads(file: DiffFile, threads: readonly ReviewThread[]) {
  const wholeFile = threads.filter((thread) => thread.startLine === 0);
  // Until an on-demand patch is loaded, line threads cannot be placed: they wait above the button.
  if (file.patch === null) {
    return { lines: undefined, wholeFile, onLines: [], unplaced: threads.filter((thread) => thread.startLine > 0), outdated: [] };
  }
  const lines = parsePatchLines(file.patch);
  const placed = threads.filter((thread) => thread.startLine > 0).map((thread) => ({ thread, placement: placeThread(thread, lines) }));
  return {
    lines,
    wholeFile,
    onLines: placed.filter(({ placement }) => placement.state !== "outdated"),
    unplaced: [],
    outdated: placed.filter(({ placement }) => placement.state === "outdated").map(({ thread }) => thread),
  };
}

function lineCount(file: DiffFile): string {
  return `+${file.additions} −${file.deletions}`;
}

export interface FileDiffProps {
  file: DiffFile;
  threads: readonly ReviewThread[];
  /** Whether the header shows how many comment threads the file has, open and closed. */
  showThreadCount: boolean;
  diffStyle: DiffStyle;
  /** The patch shown is the previous load's, kept on screen while it is fetched again. */
  stalePatch?: boolean;
  /** Where the patch stands when bb did not send it with the file list; undefined before it is asked for. */
  patchState: PatchState | undefined;
  /** Asks for the patch; called on its own when the file comes near the screen. */
  requestPatch(path: string): void;
  /** The tab's scroll container, to tell when the file comes near the screen. */
  scrollRoot: Element | null;
}

/** Why a file shows no line diff, or null when it can. */
export function noDiffReason(file: DiffFile): string | null {
  if (file.binary) return "Binary file; no line diff.";
  if (file.loadMode === "too_large") return "This file's diff is too large to show.";
  return null;
}

/**
 * How far to scroll `root` up so `section` starts at its top: the section's top minus the root's,
 * when the section starts above the visible area (its sticky header is pinned while the rest of it
 * is scrolled past); 0 otherwise.
 */
export function scrollToAlign(section: Element, root: Element): number {
  const offset = section.getBoundingClientRect().top - root.getBoundingClientRect().top;
  return offset < 0 ? offset : 0;
}

/** The header's comment count: open threads, and resolved or dismissed ones, with the words a screen reader says. */
export function threadCount(threads: readonly ReviewThread[]): { open: number; closed: number; label: string } {
  const open = threads.filter((thread) => thread.status === "open").length;
  const closed = threads.length - open;
  const parts = [open > 0 ? `${open} open` : null, closed > 0 ? `${closed} resolved or dismissed` : null].filter((part) => part !== null);
  return { open, closed, label: `${threads.length} comment thread${threads.length === 1 ? "" : "s"}: ${parts.join(", ")}` };
}

export function FileDiff({ file, threads, showThreadCount, diffStyle, stalePatch = false, patchState, requestPatch, scrollRoot }: FileDiffProps) {
  const actions = useActions();
  const codeTheme = experimental_useCodeTheme();
  const settings = useSettings();
  const palette = useMemo(() => paletteStyle(settings.values?.[COLOR_BLIND_SETTING] === true, codeTheme.mode), [settings.values, codeTheme.mode]);
  const viewState = useViewState();
  const changedLines = file.additions + file.deletions;
  // Folded or unfolded by hand, a file stays so; otherwise a large change starts folded.
  // A file with an unsent comment in it opens, so the comment shows.
  const [collapsed, setCollapsed] = useState(() => {
    if (viewState.draft(draftKeys.line(file.path)) !== undefined || viewState.draft(draftKeys.file(file.path)) !== undefined) return false;
    // A file marked Viewed (in this tab or bb's diff panel) starts folded, as bb's panel shows it.
    return viewState.collapsed(file.path) ?? (file.viewed === "yes" || changedLines > FOLD_ABOVE_LINES);
  });
  const sectionRef = useRef<HTMLElement>(null);
  // Folding a file scrolled part-way through would leave the scroll offset where it was, so the next
  // file would show up already scrolled down by as much. Pull the folded file's header to the top.
  const alignAfterFold = useRef(0);
  useLayoutEffect(() => {
    if (!collapsed || alignAfterFold.current === 0 || scrollRoot === null) return;
    scrollRoot.scrollTop += alignAfterFold.current;
    alignAfterFold.current = 0;
  }, [collapsed, scrollRoot]);
  // The whole-file comment box is inside the file's body: opening it unfolds the file (and keeps it so).
  const openFileDraft = () => {
    if (collapsed) {
      viewState.setCollapsed(file.path, false);
      setCollapsed(false);
    }
    fileDraft.open();
  };
  const toggleCollapsed = () => {
    if (!collapsed && sectionRef.current !== null && scrollRoot !== null) alignAfterFold.current = scrollToAlign(sectionRef.current, scrollRoot);
    viewState.setCollapsed(file.path, !collapsed);
    setCollapsed(!collapsed);
  };
  // Marking a file Viewed folds it and clearing the mark unfolds it, as in bb's diff panel.
  const toggleViewed = (viewed: boolean) => {
    if (viewed !== collapsed) toggleCollapsed();
    void actions.setViewed(file, viewed).catch(() => undefined);
  };
  const reason = noDiffReason(file);
  // The patch loads by itself once the file is near the screen; a folded file waits until unfolded.
  // A stale patch (the previous load's, still shown) is fetched again the same way.
  useNearScreen(sectionRef, scrollRoot, (file.patch === null || stalePatch) && reason === null && !collapsed && patchState === undefined, () => requestPatch(file.path));
  // A new comment on lines: one per file, as the gutter offers. Its text lives in the view state, not
  // in its composer: Pierre may remount annotations when the patch reloads (an agent's turn ended).
  const lineDraft = useDraft(draftKeys.line(file.path));
  const lineDraftRef = useRef(lineDraft);
  lineDraftRef.current = lineDraft;
  const draft: LineRange | null = lineDraft.active?.range ?? null;
  const fileDraft = useDraft(draftKeys.file(file.path));
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);

  const { lines, wholeFile, onLines, unplaced } = useMemo(() => placeFileThreads(file, threads), [file, threads]);

  // A restored line draft goes under its lines when the diff still shows them; otherwise above the
  // diff, so it is never out of sight.
  const draftInDiff = draft !== null && lines !== undefined && linesText(lines, draft.side, draft.startLine, draft.endLine) !== null;
  const draftAbove = draft === null || draftInDiff ? null : lines === undefined ? "It shows in place once the diff loads." : "Those lines are no longer in this diff.";

  const annotations = useMemo(() => {
    const byLine = new Map<string, DiffLineAnnotation<Annotation>>();
    for (const entry of onLines) {
      if (entry.placement.state === "outdated" || entry.thread.side === null) continue;
      const side = toPierreSide(entry.thread.side);
      const key = `${side}:${entry.placement.endLine}`;
      const existing = byLine.get(key);
      if (existing !== undefined && existing.metadata.kind === "threads") existing.metadata.threads.push(entry);
      else byLine.set(key, { side, lineNumber: entry.placement.endLine, metadata: { kind: "threads", threads: [entry] } });
    }
    const list = [...byLine.values()];
    if (draft !== null && draftInDiff) list.push({ side: toPierreSide(draft.side), lineNumber: draft.endLine, metadata: { kind: "draft", ...draft } });
    return list;
  }, [onLines, draft, draftInDiff]);

  const options = useMemo(
    () => ({
      diffStyle,
      theme: codeTheme.name,
      themeType: codeTheme.mode,
      overflow: "wrap" as const,
      disableFileHeader: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      onLineSelected: (range: SelectedLineRange | null) => setSelected(range),
      onGutterUtilityClick: (range: SelectedLineRange) => {
        lineDraftRef.current.open({ range: draftFrom(range) });
        setSelected(null);
      },
    }),
    [diffStyle, codeTheme.name, codeTheme.mode],
  );

  const renderAnnotation = (annotation: DiffLineAnnotation<Annotation>) => {
    const meta = annotation.metadata;
    return (
      <div className={ANNOTATION_FIT} data-annotation-fit="">
        {meta.kind === "threads" ? (
          <div className="flex flex-col gap-2 px-3 py-2">
            {meta.threads.map(({ thread, placement }) => (
              <ThreadCard key={thread.id} thread={thread} placement={placement} fileChanged={changedSince(thread, file)} />
            ))}
          </div>
        ) : (
          lineDraftComposer(meta, null)
        )}
      </div>
    );
  };

  /** The new comment on lines, in place under them, or above the diff with `note` saying why not. */
  const lineDraftComposer = (meta: LineRange, note: string | null) => (
    <LineDraftBox
      filePath={file.path}
      fileRevision={file.revision}
      range={meta}
      draft={lineDraft}
      note={note}
      anchorContent={lines === undefined ? null : linesText(lines, meta.side, meta.startLine, meta.endLine)}
    />
  );

  let body: React.ReactNode;
  if (reason !== null) body = <p className="px-3 py-2 text-xs text-muted-foreground">{reason}</p>;
  else if (file.patch === null && patchState === "failed")
    body = (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        Could not load this file's diff.
        <Button type="button" variant="outline" size="sm" onClick={() => requestPatch(file.path)}>
          Try again
        </Button>
      </div>
    );
  else if (file.patch === null && patchState === "missing") body = <p className="px-3 py-2 text-xs text-muted-foreground">No diff for this file now; it changed meanwhile. Reload the review.</p>;
  else if (file.patch === null) body = <p className="min-h-16 px-3 py-2 text-xs text-muted-foreground">Loading the diff…</p>;
  else
    body = (
      <div style={palette} data-diff-palette={palette === undefined ? undefined : "colorblind"}>
        <PatchDiff<Annotation, undefined>
          patch={file.patch}
          options={options}
          lineAnnotations={annotations}
          selectedLines={selected}
          renderAnnotation={renderAnnotation}
        />
      </div>
    );

  return (
    <section ref={sectionRef} className="border-b border-border" data-file-path={file.path}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1" aria-label={collapsed ? "Expand file" : "Collapse file"} onClick={toggleCollapsed}>
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
        </Button>
        <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
          {file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {file.untracked ? "new, untracked · " : file.changeKind === "modified" ? "" : `${file.changeKind} · `}
          {lineCount(file)}
        </span>
        {file.patchTruncated ? <span className="shrink-0 text-xs text-warning-text">truncated</span> : null}
        {collapsed && changedLines > FOLD_ABOVE_LINES ? <span className="shrink-0 text-xs text-muted-foreground">folded: a large change</span> : null}
        {showThreadCount && threads.length > 0 ? <ThreadCount threads={threads} /> : null}
        {file.viewed === "changed" ? (
          <span className="shrink-0 text-xs text-warning-text" title="You marked this file Viewed; it has changed since.">
            changed since viewed
          </span>
        ) : null}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground">
          <Checkbox checked={file.viewed === "yes"} onCheckedChange={(checked) => toggleViewed(checked === true)} aria-label={`Viewed ${file.path}`} />
          Viewed
        </label>
        {actions.canOpenFile(file) ? (
          <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs" onClick={() => actions.openFile(file)} aria-label={`Open ${file.path}`}>
            <Icon name="ExternalLink" className="size-3.5" />
            Open
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs" onClick={openFileDraft}>
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment on file
        </Button>
      </header>
      {collapsed ? null : (
        <>
          {wholeFile.length > 0 || unplaced.length > 0 || fileDraft.active !== null || draftAbove !== null ? (
            <div className="flex flex-col gap-2 px-3 py-2">
              {wholeFile.map((thread) => (
                <ThreadCard key={thread.id} thread={thread} fileChanged={changedSince(thread, file)} />
              ))}
              {unplaced.map((thread) => (
                <div key={thread.id} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">On {describeLocation(thread)}; it shows in place once the diff loads.</span>
                  <ThreadCard thread={thread} />
                </div>
              ))}
              {draft !== null && draftAbove !== null ? lineDraftComposer(draft, draftAbove) : null}
              {fileDraft.active !== null ? (
                <CommentComposer
                  placeholder="A comment about the whole file"
                  submitLabel="Comment"
                  withSeverity
                  initialBody={fileDraft.latest().body}
                  initialSeverity={fileDraft.latest().severity}
                  onChange={fileDraft.change}
                  onSubmit={async ({ body: text, severity }) => {
                    await actions.create({ filePath: file.path, side: null, startLine: 0, endLine: 0, anchorContent: null, body: text, severity, fileRevision: file.revision });
                    fileDraft.close();
                  }}
                  onCancel={fileDraft.close}
                />
              ) : null}
            </div>
          ) : null}
          {body}
        </>
      )}
    </section>
  );
}

/** Whether the file changed since the thread was made on it (by the revision bb's Git plugin gives). */
export function changedSince(thread: Pick<ReviewThread, "fileRevision">, file: Pick<DiffFile, "revision">): boolean {
  return thread.fileRevision !== null && thread.fileRevision !== file.revision;
}

function ThreadCount({ threads }: { threads: readonly ReviewThread[] }) {
  const { open, closed, label } = threadCount(threads);
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs" role="img" aria-label={label} title={label}>
      <Icon name="MessageSquare" className="size-3.5 text-muted-foreground" />
      {open > 0 ? <span>{open} open</span> : null}
      {open > 0 && closed > 0 ? <span className="text-muted-foreground">·</span> : null}
      {closed > 0 ? <span className="text-muted-foreground">{closed} closed</span> : null}
    </span>
  );
}

/** A new comment on lines: what it is about, and its editor, bound to its draft. */
function LineDraftBox({
  filePath,
  fileRevision = null,
  range,
  draft,
  note,
  anchorContent,
}: {
  filePath: string;
  fileRevision?: string | null;
  range: LineRange;
  draft: ReturnType<typeof useDraft>;
  note: string | null;
  /** The commented lines' text in the current diff, or null when it does not show them. */
  anchorContent: string | null;
}) {
  const actions = useActions();
  const lines = range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}–${range.endLine}`;
  return (
    <div className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2 font-sans">
      <span className="text-xs text-muted-foreground">
        New comment on {lines} ({range.side === "old" ? "removed" : "new"} side){note === null ? "" : `. ${note}`}
      </span>
      <CommentComposer
        placeholder="Leave a comment. Markdown works; @reviewer (or @agent) asks this view's AI reviewer."
        submitLabel="Comment"
        withSeverity
        initialBody={draft.latest().body}
        initialSeverity={draft.latest().severity}
        onChange={draft.change}
        onSubmit={async ({ body, severity }) => {
          await actions.create({ filePath, side: range.side, startLine: range.startLine, endLine: range.endLine, anchorContent, body, severity, fileRevision });
          draft.close();
        }}
        onCancel={draft.close}
      />
    </div>
  );
}

/**
 * The unsent comments on a file that is not in the view any more (committed, reverted, or left out by
 * the ignore patterns since), so they can still be sent or cancelled.
 */
export function OrphanDrafts({ path }: { path: string }) {
  const actions = useActions();
  const lineDraft = useDraft(draftKeys.line(path));
  const fileDraft = useDraft(draftKeys.file(path));
  const range = lineDraft.active?.range ?? null;
  if (range === null && fileDraft.active === null) return null;
  return (
    <div className="flex flex-col gap-2" data-orphan-path={path}>
      <span className="truncate font-mono text-xs" title={path}>
        {path}
      </span>
      {range === null ? null : <LineDraftBox filePath={path} range={range} draft={lineDraft} note="This file is not in this view any more." anchorContent={null} />}
      {fileDraft.active === null ? null : (
        <CommentComposer
          placeholder="A comment about the whole file"
          submitLabel="Comment"
          withSeverity
          autoFocus={false}
          initialBody={fileDraft.latest().body}
          initialSeverity={fileDraft.latest().severity}
          onChange={fileDraft.change}
          onSubmit={async ({ body, severity }) => {
            await actions.create({ filePath: path, side: null, startLine: 0, endLine: 0, anchorContent: null, body, severity });
            fileDraft.close();
          }}
          onCancel={fileDraft.close}
        />
      )}
    </div>
  );
}
