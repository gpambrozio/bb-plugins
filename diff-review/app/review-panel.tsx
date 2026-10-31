/**
 * The Review tab beside a thread: that thread's workspace diff, drawn by the plugin with bb's
 * `@pierre/diffs`, with comment threads on lines, ranges, files and the whole diff, and "Send to
 * agent", which hands the open ones to this thread.
 *
 * AI review starts a review run; the runs not yet closed are listed under the toolbar. "Only files with
 * comments" narrows the files to those with a comment thread, for going through a review's findings.
 * "Clear review", shown once the view has threads or runs, deletes them all (after a confirm).
 * Unsent comments, folds and the scroll position are kept per thread and view (`view-state.tsx`).
 *
 * A tab opened with `params: { target }` starts on that view; otherwise on the uncommitted changes, or,
 * when there are none, on the changes committed since the base branch. A view picked in the tab is
 * kept per thread (`view-memory.ts`), so coming back to the thread shows it again, unless it is gone.
 */
import { experimental_useTabVisible, useRpc, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { RpcContract } from "../shared/contract";
import { parseRange, rangeText } from "../shared/git-spec";
import { parsePullText, pullText } from "../shared/github";
import { linesText, parsePatchLines } from "../shared/patch-lines";
import { describeLocation, GENERAL_PATH, type ReviewThread, type Run, type Target, type TargetRequest } from "../shared/types";
import { ReviewActionsProvider, useActions } from "./actions";
import { useReviewCommands } from "./commands";
import { carryCurrent, findInFiles, type FindMatch } from "./find";
import { FilesView } from "./files-view";
import { FindBar } from "./find-bar";
import { GoToDialog, type GoToEntry } from "./goto-dialog";
import { PullBar } from "./pull-bar";
import { PullDialog } from "./pull-dialog";
import { RangeDialog } from "./range-dialog";
import { SubmitReviewDialog } from "./submit-dialog";
import type { Reveal } from "./reveal";
import { AiReviewDialog } from "./ai-review-dialog";
import { ClearReviewDialog } from "./clear-dialog";
import { cancelFocus, CommentNavButtons, CommentNavContext, focusThread, stepTarget, TAKE_OVER, type CommentNav, type CommentPlace } from "./comment-nav";
import { CommentComposer } from "./comment-composer";
import { FileDiff, noDiffReason, OrphanDrafts, placeFileThreads, type DiffStyle } from "./file-diff";
import { usePatchLoader } from "./patch-loader";
import { targetLabel } from "./labels";
import { RunsList } from "./runs-list";
import { useScrollMemory } from "./scroll-memory";
import { SendDialog } from "./send-dialog";
import { ThreadCard } from "./thread-card";
import { errorMessage, useReview, type PendingView, type ReadyView } from "./use-review";
import { forgetView, keepView, startingView } from "./view-memory";
import { draftKeys, useDraft, useDraftKeys, useViewState, ViewStateProvider } from "./view-state";

const DIFF_STYLE_KEY = "diff-review:diff-style";
/** "Hide whitespace" is one choice for every thread, like split/unified. */
const WHITESPACE_KEY = "diff-review:ignore-whitespace";
/** "Only files with comments" is kept per bb thread: a thread that never set it starts with it off. */
const onlyCommentedKey = (threadId: string) => `diff-review:only-commented:${threadId}`;

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser without storage just forgets the choice.
  }
}

const NO_THREADS: readonly ReviewThread[] = [];

/** Threads by file path; a file whose threads are the same objects as in `previous` keeps that array. */
export function groupByFile(threads: readonly ReviewThread[], previous: ReadonlyMap<string, readonly ReviewThread[]>): ReadonlyMap<string, readonly ReviewThread[]> {
  const groups = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const list = groups.get(thread.filePath) ?? [];
    list.push(thread);
    groups.set(thread.filePath, list);
  }
  const shared = new Map<string, readonly ReviewThread[]>();
  for (const [path, list] of groups) {
    const old = previous.get(path);
    shared.set(path, old !== undefined && old.length === list.length && old.every((thread, index) => thread === list[index]) ? old : list);
  }
  return shared;
}

/**
 * The files a view shows: all of them, or with `onlyCommented` those with a comment thread or an
 * unsent comment (`hasDraft`).
 */
export function shownFiles<File extends { path: string }>(
  files: readonly File[],
  byFile: ReadonlyMap<string, readonly ReviewThread[]>,
  onlyCommented: boolean,
  hasDraft: (path: string) => boolean = () => false,
): readonly File[] {
  return onlyCommented ? files.filter((file) => (byFile.get(file.path)?.length ?? 0) > 0 || hasDraft(file.path)) : files;
}

/** The picker items that open the range and pull request dialogs rather than a view. */
const PICK_RANGE = "pick-range";
const PICK_PULL = "pick-pull";

export function pickerValue(target: TargetRequest): string {
  if (target.kind === "commit") return `commit:${target.sha}`;
  if (target.kind === "range") return `range:${rangeText(target)}`;
  if (target.kind === "pr") return `pr:${pullText(target)}`;
  return target.kind;
}

export function fromPicker(value: string): TargetRequest {
  if (value.startsWith("commit:")) return { kind: "commit", sha: value.slice("commit:".length) };
  if (value.startsWith("range:")) return parseRange(value.slice("range:".length)) ?? { kind: "uncommitted" };
  if (value.startsWith("pr:")) {
    const pull = parsePullText(value.slice("pr:".length));
    return pull === null ? { kind: "uncommitted" } : { kind: "pr", ...pull };
  }
  if (value === "branch" || value === "all" || value === "staged" || value === "unstaged" || value === "files") return { kind: value };
  return { kind: "uncommitted" };
}

/** The picker's label for a view asked for; a branch view without a base compares against `defaultBase`. */
export function requestLabel(target: TargetRequest, defaultBase: string | null): string {
  if (target.kind === "branch" || target.kind === "all") return targetLabel({ kind: target.kind, base: target.base ?? defaultBase ?? "the base branch" });
  return targetLabel(target as Target);
}

/** Whether a kept view that loaded is not one to come back to: a pull request closed or merged since. */
export function keptViewGone(view: ReadyView): boolean {
  return view.target.kind === "pr" && view.pullRequest !== null && view.pullRequest.state !== "OPEN";
}

/** The Review tab beside a thread; it keeps the view picked in it per thread. */
export function ReviewPanel({ threadId, params, environment }: ExperimentalThreadActionTabProps) {
  const visible = experimental_useTabVisible();
  // A kept view that turned out gone is forgotten, and the tab starts over on the default one.
  const [start, setStart] = useState(0);
  const onKeptViewGone = useCallback(() => {
    forgetView(threadId);
    setStart((count) => count + 1);
  }, [threadId]);
  return (
    <ReviewBody
      key={`${threadId} ${start}`}
      threadId={threadId}
      environmentId={environment?.id ?? null}
      params={params}
      visible={visible}
      keepViews
      onKeptViewGone={onKeptViewGone}
    />
  );
}

/**
 * One thread's review: the Review tab's content, and the Reviews page's for the review it opens.
 * `visible`: whether it shows; a hidden one leaves reloads until it shows again.
 */
export function ReviewBody({
  threadId,
  environmentId,
  params,
  visible,
  initialFile = null,
  keepViews = false,
  onKeptViewGone,
}: {
  threadId: string;
  environmentId: string | null;
  params: unknown;
  visible: boolean;
  /** A file to go to once the view has loaded (`bb diff-review open <file>`). */
  initialFile?: string | null;
  /** Keep the view picked here for the thread, and start on the one kept (the Review tab). */
  keepViews?: boolean;
  /** The kept view this started on cannot be loaded any more. */
  onKeptViewGone?: () => void;
}) {
  const [start] = useState(() => startingView(params, keepViews ? threadId : null));
  const [target, setTarget] = useState<TargetRequest>(start.target);
  // A tab opened without a view starts on the uncommitted changes, unless there are none and the
  // branch has commits: the first load decides, and the picker follows it.
  const autoTarget = start.auto;
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => stored(WHITESPACE_KEY) === "true");
  const review = useReview(threadId, target, { environmentId, autoTarget, onTarget: setTarget, ignoreWhitespace, visible });
  const toggleWhitespace = (next: boolean) => {
    setIgnoreWhitespace(next);
    store(WHITESPACE_KEY, String(next));
  };
  const { state } = review;

  const pick = (value: string) => {
    const next = fromPicker(value);
    setTarget(next);
    if (keepViews) keepView(threadId, params, next);
  };
  // The kept view's first answer says whether it is still there: the server cannot read it (a range
  // whose branch was deleted), or it is not one to come back to (`keptViewGone`). An error may pass,
  // so the view stays.
  const checkedKept = useRef(!start.restored);
  useEffect(() => {
    if (checkedKept.current || state.status === "loading") return;
    checkedKept.current = true;
    if (state.status === "unavailable" || (state.status === "ready" && keptViewGone(state.view))) onKeptViewGone?.();
  }, [state, onKeptViewGone]);
  const reload = review.reload;
  const onEdited = useCallback(() => void reload("manual"), [reload]);

  if (state.status === "loading") return <Centered>Loading the diff…</Centered>;
  if (state.status === "unavailable") return <Centered>{state.message}</Centered>;
  if (state.status === "error") {
    return (
      <Centered>
        <span>Could not load the review: {state.message}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void review.reload("retry")}>
          Try again
        </Button>
      </Centered>
    );
  }

  return (
    <ReviewActionsProvider
      sessionId={state.view.sessionId}
      threadId={threadId}
      view={state.view}
      ignoreWhitespace={ignoreWhitespace}
      putThread={review.putThread}
      changeViewed={review.changeViewed}
      putRun={review.putRun}
      refreshThreads={review.refreshThreads}
      onEdited={onEdited}
    >
      {/* Keyed by the view: each view of this thread has its own drafts, folds and place. */}
      <ViewStateProvider key={state.view.sessionId} threadId={threadId} sessionId={state.view.sessionId} saved={state.view.viewState}>
      <ReadyPanel
        threadId={threadId}
        view={state.view}
        refreshing={state.refreshing}
        pending={state.pending}
        pickerValue={
          state.pending !== null
            ? pickerValue(state.pending.target)
            : pickerValue(state.view.target.kind === "commit" || state.view.target.kind === "range" || state.view.target.kind === "pr" ? state.view.target : target)
        }
        onPick={pick}
        onReload={() => void review.reload("manual")}
        loadId={state.loadId}
        stalePatches={state.stalePatches}
        putPatches={review.putPatches}
        putRun={review.putRun}
        refreshThreads={review.refreshThreads}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespace={toggleWhitespace}
        visible={visible}
        initialFile={initialFile}
      />
      </ViewStateProvider>
    </ReviewActionsProvider>
  );
}

/** Over the dimmed previous view: bb's spinner while the picked view loads, or why it could not. */
function PendingOverlay({ label, error, onRetry }: { label: string; error: string | null; onRetry(): void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center p-6" role="status" aria-live="polite">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-md border border-border bg-background px-4 py-3 text-center text-sm shadow-sm">
        {error === null ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Icon name="Spinner" className="size-4" />
            Loading {label}…
          </span>
        ) : (
          <>
            <span className="text-destructive">
              Could not load {label}: {error}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function ReadyPanel({
  threadId,
  view,
  refreshing,
  pending,
  pickerValue: value,
  onPick,
  onReload,
  loadId,
  stalePatches,
  putPatches,
  putRun,
  refreshThreads,
  ignoreWhitespace,
  onIgnoreWhitespace,
  visible,
  initialFile,
}: {
  threadId: string;
  view: ReadyView;
  refreshing: boolean;
  /** Another view was picked and is loading (or failed to): `view` is the previous one, dimmed. */
  pending: PendingView | null;
  pickerValue: string;
  onPick(value: string): void;
  onReload(): void;
  loadId: number;
  stalePatches: ReadonlySet<string>;
  putPatches(sessionId: string, loadId: number, patches: readonly { path: string; patch: string; truncated: boolean }[]): void;
  putRun(run: Run): void;
  refreshThreads(): Promise<void>;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace(next: boolean): void;
  visible: boolean;
  initialFile: string | null;
}) {
  const rpc = useRpc<RpcContract>();
  const actions = useActions();
  // A range or pull request picked by address has no item of its own in the picker until it loads.
  const pendingItem = useMemo(() => {
    if (pending === null || (pending.target.kind !== "range" && pending.target.kind !== "pr")) return null;
    const value = pickerValue(pending.target);
    const listed = [
      view.target.kind === "range" || view.target.kind === "pr" ? pickerValue(view.target) : null,
      view.branchPullRequest === null ? null : `pr:${pullText(view.branchPullRequest)}`,
    ];
    return listed.includes(value) ? null : { value, label: requestLabel(pending.target, view.defaultBase) };
  }, [pending, view.target, view.branchPullRequest, view.defaultBase]);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => (stored(DIFF_STYLE_KEY) === "split" ? "split" : "unified"));
  const [onlyCommented, setOnlyCommented] = useState(() => stored(onlyCommentedKey(threadId)) === "true");
  const viewState = useViewState();
  const generalDraft = useDraft(draftKeys.general);
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [clearing, setClearing] = useState(false);

  const toggleStyle = () => {
    const next = diffStyle === "split" ? "unified" : "split";
    setDiffStyle(next);
    store(DIFF_STYLE_KEY, next);
  };

  const toggleOnlyCommented = (next: boolean) => {
    setOnlyCommented(next);
    store(onlyCommentedKey(threadId), String(next));
  };

  // Each file's threads keep their array while they are the same threads, so a reply re-renders
  // only its own file (Pierre redraws a diff whenever its annotations array is a new one).
  const lastByFile = useRef<ReadonlyMap<string, readonly ReviewThread[]>>(new Map());
  const byFile = useMemo(() => {
    const next = groupByFile(view.threads, lastByFile.current);
    lastByFile.current = next;
    return next;
  }, [view.threads]);

  const general = byFile.get(GENERAL_PATH) ?? [];
  const outdated = useMemo(() => {
    const inDiff = new Set(view.files.map((file) => file.path));
    const gone = view.threads.filter((thread) => thread.filePath !== GENERAL_PATH && !inDiff.has(thread.filePath));
    const stale = view.files.flatMap((file) => placeFileThreads(file, byFile.get(file.path) ?? []).outdated);
    return [...gone, ...stale];
  }, [view.files, view.threads, byFile]);

  const open = view.threads.filter((thread) => thread.status === "open");

  // What an outdated thread's own lines read now, so its suggestion can say it was applied.
  const originalLines = (thread: ReviewThread) => {
    const patch = view.files.find((file) => file.path === thread.filePath)?.patch ?? null;
    if (patch === null || thread.side === null || thread.startLine === 0) return undefined;
    const text = linesText(parsePatchLines(patch), thread.side, thread.startLine, thread.endLine);
    return text === null ? undefined : { startLine: thread.startLine, endLine: thread.endLine, text };
  };

  // Patches bb did not send with the file list load as their files come near the screen.
  const loadPatches = useCallback(
    async (paths: string[]) => {
      try {
        // Each file at the revision this load's file list gave, so bb answers for that version.
        const revisions = new Map(view.files.map((file) => [file.path, file.revision]));
        const files = paths.flatMap((path) => {
          const revision = revisions.get(path);
          return revision === undefined ? [] : [{ path, revision }];
        });
        if (files.length === 0) return [];
        const { patches } = await rpc.call("loadPatches", { threadId, target: view.target, files, ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}) });
        putPatches(view.sessionId, loadId, patches);
        return patches.map((patch) => patch.path);
      } catch (error) {
        toast.error(`Could not load ${paths.length === 1 ? `the diff of ${paths[0]}` : `${paths.length} files' diffs`}: ${errorMessage(error)}`);
        throw error;
      }
    },
    [rpc, threadId, view.target, view.files, view.sessionId, loadId, putPatches, ignoreWhitespace],
  );
  const patchLoader = usePatchLoader(loadPatches, `${view.sessionId}:${loadId}`);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  useScrollMemory(scrollRoot, viewState.scroll(), viewState.setScroll);

  // A commit view opened from params may name a commit the branch list does not hold.
  const shown = view.target;
  const orphanCommit = shown.kind === "commit" && !view.commits.some((commit) => commit.sha === shown.sha) ? shown : null;

  // Files with an unsent comment: shown by the comment filter, and listed apart once out of the view.
  const draftKeyList = useDraftKeys();
  const draftPaths = new Set(draftKeyList.filter((key) => key.startsWith("file:") || key.startsWith("line:")).map((key) => key.slice("file:".length)));
  const files = shownFiles(view.files, byFile, onlyCommented, (path) => draftPaths.has(path));
  const inView = new Set(view.files.map((file) => file.path));
  const orphanPaths = [...draftPaths].filter((path) => !inView.has(path));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  // "Any file": the workspace's files, not a diff.
  const browsing = view.target.kind === "files";
  // Comments on the whole diff and its draft, in every view, "Any file" included.
  const generalSection =
    general.length > 0 || generalDraft.active !== null ? (
      <section className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <h3 className="text-xs font-medium text-muted-foreground">About the whole diff</h3>
        {general.map((thread) => (
          <ThreadCard key={thread.id} thread={thread} />
        ))}
        {generalDraft.active !== null ? (
          <CommentComposer
            placeholder="A comment about the whole change"
            submitLabel="Comment"
            withSeverity
            initialBody={generalDraft.latest().body}
            initialSeverity={generalDraft.latest().severity}
            onChange={generalDraft.change}
            onSubmit={async ({ body, severity }) => {
              await actions.create({ filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, anchorContent: null, body, severity });
              generalDraft.close();
            }}
            onCancel={generalDraft.close}
          />
        ) : null}
      </section>
    ) : null;
  const fileCount = onlyCommented ? `${files.length} of ${view.files.length} files` : `${files.length} file${files.length === 1 ? "" : "s"}`;

  // A place in the diff to bring into view: a find match, a "Go to" pick, the next comment.
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealSeq = useRef(0);
  // A step to a thread whose file's diff is loading waits for it (`goToComment`) and lands once its
  // place is known (or under the file's header if the diff cannot be had).
  const [awaitedComment, setAwaitedComment] = useState<string | null>(null);
  // Every jump (find, Go to, a step) replaces the one before: a step still waiting for its diff, or
  // for its card to be drawn, gives up, so it never pulls the view back when it would have landed.
  const show = useCallback(
    (place: Omit<Reveal, "seq">) => {
      setAwaitedComment(null);
      cancelFocus(scrollRoot);
      setReveal({ ...place, seq: ++revealSeq.current });
    },
    [scrollRoot],
  );
  // A jump that brings no file into view (a comment in the top sections) ends the previous jump's
  // reveal too: a file still loading its diff reveals itself again when the diff arrives, which would
  // pull the view back to it.
  const expireJumps = useCallback(() => {
    setAwaitedComment(null);
    setReveal(null);
  }, []);
  // So does the user scrolling or clicking in the diff.
  useEffect(() => {
    if (scrollRoot === null) return;
    for (const type of TAKE_OVER) scrollRoot.addEventListener(type, expireJumps, { passive: true });
    return () => {
      for (const type of TAKE_OVER) scrollRoot.removeEventListener(type, expireJumps);
    };
  }, [scrollRoot, expireJumps]);

  // Find across the diff's loaded lines; files whose diff is not loaded yet are fetched while it is open.
  const [find, setFind] = useState<{ open: boolean; query: string; caseSensitive: boolean; focus: number }>({ open: false, query: "", caseSensitive: false, focus: 0 });
  const found = useMemo(() => (find.open ? findInFiles(files, find.query, find.caseSensitive) : { matches: [] as FindMatch[], truncated: false }), [files, find.open, find.query, find.caseSensitive]);
  const [matchIndex, setMatchIndex] = useState(-1);
  const currentMatch = useRef<FindMatch | null>(null);
  const findLoading = find.open && find.query !== "" && files.some((file) => file.patch === null && noDiffReason(file) === null && patchLoader.states.get(file.path) !== "failed" && patchLoader.states.get(file.path) !== "missing");
  useEffect(() => {
    if (!find.open || find.query === "") return;
    for (const file of files) if (file.patch === null && noDiffReason(file) === null && patchLoader.states.get(file.path) === undefined) patchLoader.request(file.path);
  }, [find.open, find.query, files, patchLoader]);
  // A new result keeps the match on screen when it is still there, else starts at the first.
  useEffect(() => {
    const carried = carryCurrent(currentMatch.current, found.matches);
    const index = carried >= 0 ? carried : found.matches.length > 0 ? 0 : -1;
    setMatchIndex(index);
    const match = index >= 0 ? found.matches[index]! : null;
    if (match !== null && (currentMatch.current === null || carried < 0)) show({ path: match.path, side: match.side, line: match.line });
    currentMatch.current = match;
  }, [found, show]);
  const stepMatch = (delta: 1 | -1) => {
    if (found.matches.length === 0) return;
    const index = (matchIndex + delta + found.matches.length) % found.matches.length;
    const match = found.matches[index]!;
    setMatchIndex(index);
    currentMatch.current = match;
    show({ path: match.path, side: match.side, line: match.line });
  };
  const openFind = () => setFind((previous) => ({ ...previous, open: true, focus: previous.focus + 1 }));
  const closeFind = () => {
    setFind((previous) => ({ ...previous, open: false }));
    currentMatch.current = null;
  };

  // The comment threads in the order the tab draws them, each with where its card is: the whole
  // diff's and the "Not on the current diff" ones in the sections at the top, a file's whole-file ones
  // under its header, then its line threads by line. A line thread whose file's diff has not loaded
  // has no place yet (pending, waiting under its file's header). The open ones are the stops of
  // next/previous comment and of Go to.
  const commentOrder = useMemo(() => {
    const stops: { threadId: string; open: boolean; place: CommentPlace }[] = [];
    const push = (thread: ReviewThread, place: CommentPlace) => stops.push({ threadId: thread.id, open: thread.status === "open", place });
    for (const thread of general) push(thread, { kind: "top" });
    for (const thread of outdated) push(thread, { kind: "top" });
    for (const file of files) {
      const threads = byFile.get(file.path) ?? [];
      if (threads.length === 0) continue;
      const placed = placeFileThreads(file, threads);
      for (const thread of placed.wholeFile) push(thread, { kind: "file", path: file.path });
      for (const thread of placed.unplaced) push(thread, { kind: "pending", path: file.path });
      const onLines = placed.onLines.map(({ thread, placement }) => ({ thread, line: placement.state === "outdated" ? 0 : placement.endLine }));
      onLines.sort((a, b) => a.line - b.line);
      for (const { thread, line } of onLines) push(thread, { kind: "line", path: file.path, side: thread.side ?? "new", line });
    }
    return stops;
  }, [general, outdated, files, byFile]);

  // A line thread's place hangs on its file's diff, so a commented file loads it at once, wherever it
  // is; the server sends most of them with the view, this covers threads added since (an AI review's).
  useEffect(() => {
    for (const file of files) {
      if (file.patch !== null || noDiffReason(file) !== null || patchLoader.states.get(file.path) !== undefined) continue;
      if ((byFile.get(file.path) ?? []).some((thread) => thread.startLine > 0)) patchLoader.request(file.path);
    }
  }, [files, byFile, patchLoader.states, patchLoader.request]);

  // The thread the last step went to (marked on screen); the one a step waits on is `awaitedComment`.
  const [currentComment, setCurrentComment] = useState<string | null>(null);
  // Brings a thread's place into view, then focuses its card: a line or a file is revealed first (which
  // unfolds the file); a card at the top needs no reveal. Steps between two places drop a wait.
  const goToComment = useCallback(
    (threadId: string, place: CommentPlace) => {
      setCurrentComment(threadId);
      if (place.kind === "pending") {
        if (patchLoader.states.get(place.path) === undefined) patchLoader.request(place.path);
        cancelFocus(scrollRoot);
        expireJumps();
        setAwaitedComment(threadId);
        return;
      }
      if (place.kind === "file") show({ path: place.path, side: "new", line: 0 });
      else if (place.kind === "line") show({ path: place.path, side: place.side, line: place.line });
      else expireJumps();
      focusThread(scrollRoot, threadId);
    },
    [show, expireJumps, scrollRoot, patchLoader.states, patchLoader.request],
  );
  useEffect(() => {
    if (awaitedComment === null) return;
    const stop = commentOrder.find((entry) => entry.threadId === awaitedComment);
    if (stop === undefined || !stop.open) {
      setAwaitedComment(null);
      return;
    }
    if (stop.place.kind !== "pending") goToComment(stop.threadId, stop.place);
    else {
      const state = patchLoader.states.get(stop.place.path);
      if (state === "failed" || state === "missing") goToComment(stop.threadId, { kind: "file", path: stop.place.path });
    }
  }, [awaitedComment, commentOrder, patchLoader.states, goToComment]);
  const commentStops = useMemo(() => commentOrder.filter((stop) => stop.open), [commentOrder]);
  // From the palette and the toolbar, from the thread the last step went to (wherever it is drawn
  // now); from a thread's own arrows, from it.
  const stepComment = (delta: 1 | -1, from: string | null = null) => {
    const start = from ?? (commentOrder.some((stop) => stop.threadId === currentComment) ? currentComment : null);
    const target = stepTarget(commentOrder, delta, start);
    if (target === null) {
      toast.info("No open comments in this view.");
      return;
    }
    goToComment(target, commentStops.find((stop) => stop.threadId === target)!.place);
  };
  const commentNav: CommentNav = {
    step: (delta, from) => stepComment(delta, from ?? null),
    canStep: (from) => stepTarget(commentOrder, 1, from ?? null) !== null,
    current: currentComment,
  };

  // "Go to": the files shown, the open comments and the views.
  const [goingTo, setGoingTo] = useState(false);
  const [pickingRange, setPickingRange] = useState(false);
  const [pickingPull, setPickingPull] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const goToEntries = useMemo<GoToEntry[]>(() => {
    const entries: GoToEntry[] = files.map((file) => ({ key: `file:${file.path}`, group: "File", label: file.path, detail: `+${file.additions} −${file.deletions}`, go: () => show({ path: file.path, side: "new", line: 0 }) }));
    for (const stop of commentStops) {
      const thread = view.threads.find((row) => row.id === stop.threadId);
      if (thread === undefined) continue;
      entries.push({
        key: `comment:${thread.id}`,
        group: "Comment",
        label: thread.comments[0]?.body.split("\n")[0]?.slice(0, 120) ?? "",
        detail: describeLocation(thread),
        go: () => goToComment(stop.threadId, stop.place),
        // A thread still waiting for its file's diff is focused once it lands.
        ...(stop.place.kind === "pending" ? {} : { focus: () => focusThread(scrollRoot, stop.threadId) }),
      });
    }
    const views: { value: string; label: string }[] = [{ value: "uncommitted", label: targetLabel({ kind: "uncommitted" }) }];
    if (view.defaultBase !== null) {
      views.push({ value: "branch", label: targetLabel({ kind: "branch", base: view.defaultBase }) }, { value: "all", label: targetLabel({ kind: "all", base: view.defaultBase }) });
    }
    for (const commit of view.commits) views.push({ value: `commit:${commit.sha}`, label: `${commit.shortSha} ${commit.subject}` });
    views.push({ value: "staged", label: targetLabel({ kind: "staged" }) }, { value: "unstaged", label: targetLabel({ kind: "unstaged" }) });
    for (const entry of views) entries.push({ key: `view:${entry.value}`, group: "View", label: entry.label, go: () => onPick(entry.value) });
    return entries;
  }, [files, commentStops, view.threads, view.defaultBase, view.commits, show, onPick, goToComment, scrollRoot]);

  // A file asked for when the review was opened, once.
  const wentToFile = useRef(false);
  useEffect(() => {
    if (initialFile === null || wentToFile.current) return;
    wentToFile.current = true;
    if (view.files.some((file) => file.path === initialFile)) show({ path: initialFile, side: "new", line: 0 });
    else toast.info(`${initialFile} is not in this view.`);
  }, [initialFile, view.files, show]);

  // The palette's commands for this thread land here while the tab shows.
  useReviewCommands(threadId, visible, (command) => {
    // Nothing acts on the previous view while another one loads.
    if (pending !== null && command !== "reload") return;
    // The Any file view has no diff to find in, review or filter.
    if (browsing && ["ai-review", "find", "toggle-style", "toggle-only-commented", "toggle-whitespace", "next-comment", "previous-comment"].includes(command)) {
      toast.info("That works on a diff; pick a view of changes first.");
      return;
    }
    switch (command) {
      case "reload":
        onReload();
        return;
      case "send":
        if (open.length > 0) setSending(true);
        else toast.info("No open comments to send.");
        return;
      case "ai-review":
        setReviewing(true);
        return;
      case "comment-diff":
        generalDraft.open();
        return;
      case "find":
        openFind();
        return;
      case "go-to":
        setGoingTo(true);
        return;
      case "next-comment":
        stepComment(1);
        return;
      case "previous-comment":
        stepComment(-1);
        return;
      case "toggle-style":
        toggleStyle();
        return;
      case "toggle-only-commented":
        toggleOnlyCommented(!onlyCommented);
        return;
      case "toggle-whitespace":
        onIgnoreWhitespace(!ignoreWhitespace);
        return;
      case "clear":
        if (view.threads.length > 0 || view.runs.length > 0) setClearing(true);
        return;
    }
  });

  return (
    <CommentNavContext.Provider value={browsing ? null : commentNav}>
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select value={value} onValueChange={(next) => (next === PICK_RANGE ? setPickingRange(true) : next === PICK_PULL ? setPickingPull(true) : onPick(next))}>
          <SelectTrigger className="h-8 w-56 text-xs" aria-label="What to review">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="uncommitted">{targetLabel({ kind: "uncommitted" })}</SelectItem>
            {view.defaultBase === null ? null : (
              <>
                <SelectItem value="branch">{targetLabel({ kind: "branch", base: view.target.kind === "branch" ? view.target.base : view.defaultBase })}</SelectItem>
                <SelectItem value="all">{targetLabel({ kind: "all", base: view.target.kind === "all" ? view.target.base : view.defaultBase })}</SelectItem>
              </>
            )}
            {view.commits.map((commit) => (
              <SelectItem key={commit.sha} value={`commit:${commit.sha}`}>
                {commit.shortSha} {commit.subject}
              </SelectItem>
            ))}
            {orphanCommit === null ? null : <SelectItem value={`commit:${orphanCommit.sha}`}>{targetLabel(orphanCommit)}</SelectItem>}
            <SelectItem value="files">{targetLabel({ kind: "files" })}</SelectItem>
            <SelectItem value="staged">{targetLabel({ kind: "staged" })}</SelectItem>
            <SelectItem value="unstaged">{targetLabel({ kind: "unstaged" })}</SelectItem>
            {view.target.kind === "range" ? <SelectItem value={`range:${rangeText(view.target)}`}>{targetLabel(view.target)}</SelectItem> : null}
            <SelectItem value={PICK_RANGE}>A range…</SelectItem>
            {view.branchPullRequest === null ? null : (
              <SelectItem value={`pr:${pullText(view.branchPullRequest)}`}>
                Pull request #{view.branchPullRequest.number}: {view.branchPullRequest.title}
              </SelectItem>
            )}
            {view.target.kind === "pr" ? <SelectItem value={`pr:${pullText(view.target)}`}>{view.pullRequest === null ? targetLabel(view.target) : `Pull request #${view.pullRequest.number}: ${view.pullRequest.title}`}</SelectItem> : null}
            {pendingItem === null ? null : <SelectItem value={pendingItem.value}>{pendingItem.label}</SelectItem>}
            <SelectItem value={PICK_PULL}>A pull request…</SelectItem>
          </SelectContent>
        </Select>
        {/* The rest of the toolbar acts on the view on screen, so it rests while another one loads. */}
        <div className={pending === null ? "contents" : "contents [&>*]:opacity-50"} inert={pending !== null}>
        {browsing ? null : (
          <>
          <Button type="button" variant="ghost" size="sm" onClick={toggleStyle} aria-pressed={diffStyle === "split"}>
            {diffStyle === "split" ? "Split" : "Unified"}
          </Button>
          <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs">
            <Switch checked={onlyCommented} onCheckedChange={toggleOnlyCommented} />
            Only files with comments
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs">
            <Switch checked={ignoreWhitespace} onCheckedChange={onIgnoreWhitespace} />
            Hide whitespace
          </label>
          <Button type="button" variant="ghost" size="sm" onClick={openFind} aria-label="Find in the diff">
            <Icon name="Search" className="size-4" />
          </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onReload} disabled={refreshing} aria-label="Reload the diff">
          <Icon name={refreshing ? "Spinner" : "ArrowReloadHorizontal"} className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => generalDraft.open()}>
          <Icon name="MessageSquarePlus" className="size-4" />
          Comment on the diff
        </Button>
        {browsing ? null : (
          <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setReviewing(true)}>
            <Icon name="Bot" className="size-4" />
            AI review
          </Button>
        )}
        {view.threads.length > 0 || view.runs.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setClearing(true)}>
            <Icon name="Trash2" className="size-4" />
            Clear review
          </Button>
        ) : null}
        {browsing ? null : <CommentNavButtons className="size-8" />}
        <Button type="button" size="sm" className="ml-auto gap-1" onClick={() => setSending(true)} disabled={open.length === 0}>
          <Icon name="Sent" className="size-4" />
          Send to agent{open.length === 0 ? "" : ` (${open.length})`}
        </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The previous view stays, dimmed and out of reach, until the one picked has loaded. */}
      <div className={pending === null ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1 flex-col opacity-40"} inert={pending !== null} aria-busy={pending !== null && pending.error === null}>

      {view.pullRequest === null ? null : (
        <PullBar pull={view.pullRequest} onSubmit={() => setSubmitting(true)} onSync={onReload} refreshing={refreshing} />
      )}

      {find.open ? (
        <FindBar
          query={find.query}
          onQuery={(query) => setFind((previous) => ({ ...previous, query }))}
          caseSensitive={find.caseSensitive}
          onCaseSensitive={(caseSensitive) => setFind((previous) => ({ ...previous, caseSensitive }))}
          count={found.matches.length}
          current={matchIndex}
          truncated={found.truncated}
          loading={findLoading}
          onStep={stepMatch}
          onClose={closeFind}
          focusKey={find.focus}
        />
      ) : null}

      <RunsList runs={view.runs} threads={view.threads} onClosed={putRun} />

      {browsing ? (
        <>
          {generalSection}
          <FilesView threadId={threadId} threads={view.threads} refreshKey={loadId} />
        </>
      ) : (
      <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {fileCount} · +{additions} −{deletions}
          {view.ignoredPaths.length === 0 ? "" : ` · ${view.ignoredPaths.length} left out by the ignore patterns`}
          {view.truncated ? " · bb cut this diff short" : ""}
        </p>

        {generalSection}

        {outdated.length > 0 ? (
          <section className="flex flex-col gap-2 border-b border-border px-3 py-2">
            <h3 className="text-xs font-medium text-muted-foreground">Not on the current diff (the code changed or left the view)</h3>
            {outdated.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} placement={{ state: "outdated" }} current={originalLines(thread)} />
            ))}
          </section>
        ) : null}

        {orphanPaths.length > 0 ? (
          <section className="flex flex-col gap-3 border-b border-border px-3 py-2">
            <h3 className="text-xs font-medium text-muted-foreground">Unsent comments on files not in this view</h3>
            {orphanPaths.map((path) => (
              <OrphanDrafts key={path} path={path} />
            ))}
          </section>
        ) : null}

        {view.files.length === 0 ? (
          <Centered>No changes to review here.</Centered>
        ) : files.length === 0 ? (
          <Centered>No file in this view has comments. Turn off "Only files with comments" to see all {view.files.length} files.</Centered>
        ) : null}
        {files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            threads={byFile.get(file.path) ?? NO_THREADS}
            stalePatch={stalePatches.has(file.path)}
            showThreadCount={!onlyCommented}
            diffStyle={diffStyle}
            patchState={patchLoader.states.get(file.path)}
            requestPatch={patchLoader.request}
            scrollRoot={scrollRoot}
            reveal={reveal?.path === file.path ? reveal : null}
          />
        ))}
      </div>
      )}
      </div>
      {pending === null ? null : <PendingOverlay label={requestLabel(pending.target, view.defaultBase)} error={pending.error} onRetry={onReload} />}
      </div>

      <SendDialog
        open={sending}
        onOpenChange={setSending}
        sessionId={view.sessionId}
        threadId={threadId}
        environmentId={view.environmentId}
        threads={open}
        onStarted={putRun}
      />
      <ClearReviewDialog
        open={clearing}
        onOpenChange={setClearing}
        sessionId={view.sessionId}
        threadCount={view.threads.length}
        runCount={view.runs.length}
        onCleared={() => void refreshThreads()}
      />
      <GoToDialog open={goingTo} onOpenChange={setGoingTo} entries={goToEntries} />
      <PullDialog open={pickingPull} onOpenChange={setPickingPull} onPick={(pull) => onPick(`pr:${pullText(pull)}`)} />
      {view.pullRequest === null ? null : (
        <SubmitReviewDialog
          open={submitting}
          onOpenChange={setSubmitting}
          sessionId={view.sessionId}
          headSha={view.pullRequest.headSha}
          pullNumber={view.pullRequest.number}
          onSubmitted={onReload}
        />
      )}
      <RangeDialog
        open={pickingRange}
        onOpenChange={setPickingRange}
        initial={view.target.kind === "range" ? rangeText(view.target) : view.defaultBase === null ? "" : `${view.defaultBase}...HEAD`}
        onPick={(range) => onPick(`range:${rangeText(range)}`)}
      />
      <AiReviewDialog open={reviewing} onOpenChange={setReviewing} sessionId={view.sessionId} threadId={threadId} environmentId={view.environmentId} onStarted={putRun} />
    </div>
    </CommentNavContext.Provider>
  );
}
