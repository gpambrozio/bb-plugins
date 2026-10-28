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
 * when there are none, on the changes committed since the base branch.
 */
import { experimental_useTabVisible, useRpc, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { RpcContract } from "../shared/contract";
import { GENERAL_PATH, targetRequestSchema, type ReviewThread, type Run, type TargetRequest } from "../shared/types";
import { ReviewActionsProvider, useActions } from "./actions";
import { AiReviewDialog } from "./ai-review-dialog";
import { ClearReviewDialog } from "./clear-dialog";
import { CommentComposer } from "./comment-composer";
import { FileDiff, OrphanDrafts, placeFileThreads, type DiffStyle } from "./file-diff";
import { usePatchLoader } from "./patch-loader";
import { targetLabel } from "./labels";
import { RunsList } from "./runs-list";
import { useScrollMemory } from "./scroll-memory";
import { SendDialog } from "./send-dialog";
import { ThreadCard } from "./thread-card";
import { errorMessage, useReview, type ReadyView } from "./use-review";
import { draftKeys, useDraft, useDraftKeys, useViewState, ViewStateProvider } from "./view-state";

const DIFF_STYLE_KEY = "diff-review:diff-style";
/** "Hide whitespace" is one choice for every thread, like split/unified. */
const WHITESPACE_KEY = "diff-review:ignore-whitespace";
/** "Only files with comments" is kept per bb thread: a thread that never set it starts with it off. */
const onlyCommentedKey = (threadId: string) => `diff-review:only-commented:${threadId}`;

function initialTarget(params: unknown): TargetRequest {
  const parsed = targetRequestSchema.safeParse((params as { target?: unknown } | null)?.target);
  return parsed.success ? parsed.data : { kind: "uncommitted" };
}

function hasTarget(params: unknown): boolean {
  return targetRequestSchema.safeParse((params as { target?: unknown } | null)?.target).success;
}

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

function pickerValue(target: TargetRequest): string {
  return target.kind === "commit" ? `commit:${target.sha}` : target.kind;
}

function fromPicker(value: string): TargetRequest {
  if (value.startsWith("commit:")) return { kind: "commit", sha: value.slice("commit:".length) };
  if (value === "branch" || value === "all") return { kind: value };
  return { kind: "uncommitted" };
}

/** The Review tab beside a thread. */
export function ReviewPanel({ threadId, params, environment }: ExperimentalThreadActionTabProps) {
  const visible = experimental_useTabVisible();
  return <ReviewBody threadId={threadId} environmentId={environment?.id ?? null} params={params} visible={visible} />;
}

/**
 * One thread's review: the Review tab's content, and the Reviews page's for the review it opens.
 * `visible`: whether it shows; a hidden one leaves reloads until it shows again.
 */
export function ReviewBody({ threadId, environmentId, params, visible }: { threadId: string; environmentId: string | null; params: unknown; visible: boolean }) {
  const [target, setTarget] = useState<TargetRequest>(() => initialTarget(params));
  // A tab opened without a view starts on the uncommitted changes, unless there are none and the
  // branch has commits: the first load decides, and the picker follows it.
  const [autoTarget] = useState(() => !hasTarget(params));
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => stored(WHITESPACE_KEY) === "true");
  const review = useReview(threadId, target, { environmentId, autoTarget, onTarget: setTarget, ignoreWhitespace, visible });
  const toggleWhitespace = (next: boolean) => {
    setIgnoreWhitespace(next);
    store(WHITESPACE_KEY, String(next));
  };
  const { state } = review;

  const pick = (value: string) => setTarget(fromPicker(value));

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
      putThread={review.putThread}
      putViewed={review.putViewed}
      refreshThreads={review.refreshThreads}
    >
      {/* Keyed by the view: each view of this thread has its own drafts, folds and place. */}
      <ViewStateProvider key={state.view.sessionId} threadId={threadId} sessionId={state.view.sessionId} saved={state.view.viewState}>
      <ReadyPanel
        threadId={threadId}
        view={state.view}
        refreshing={state.refreshing}
        pickerValue={pickerValue(state.view.target.kind === "commit" ? state.view.target : target)}
        onPick={pick}
        onReload={() => void review.reload("manual")}
        loadId={state.loadId}
        stalePatches={state.stalePatches}
        putPatches={review.putPatches}
        putRun={review.putRun}
        refreshThreads={review.refreshThreads}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespace={toggleWhitespace}
      />
      </ViewStateProvider>
    </ReviewActionsProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function ReadyPanel({
  threadId,
  view,
  refreshing,
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
}: {
  threadId: string;
  view: ReadyView;
  refreshing: boolean;
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
}) {
  const rpc = useRpc<RpcContract>();
  const actions = useActions();
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
  const fileCount = onlyCommented ? `${files.length} of ${view.files.length} files` : `${files.length} file${files.length === 1 ? "" : "s"}`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select value={value} onValueChange={onPick}>
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
          </SelectContent>
        </Select>
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
        <Button type="button" variant="ghost" size="sm" onClick={onReload} disabled={refreshing} aria-label="Reload the diff">
          <Icon name={refreshing ? "Spinner" : "ArrowReloadHorizontal"} className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => generalDraft.open()}>
          <Icon name="MessageSquarePlus" className="size-4" />
          Comment on the diff
        </Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setReviewing(true)}>
          <Icon name="Bot" className="size-4" />
          AI review
        </Button>
        {view.threads.length > 0 || view.runs.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setClearing(true)}>
            <Icon name="Trash2" className="size-4" />
            Clear review
          </Button>
        ) : null}
        <Button type="button" size="sm" className="ml-auto gap-1" onClick={() => setSending(true)} disabled={open.length === 0}>
          <Icon name="Sent" className="size-4" />
          Send to agent{open.length === 0 ? "" : ` (${open.length})`}
        </Button>
      </div>

      <RunsList runs={view.runs} threads={view.threads} onClosed={putRun} />

      <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {fileCount} · +{additions} −{deletions}
          {view.ignoredPaths.length === 0 ? "" : ` · ${view.ignoredPaths.length} left out by the ignore patterns`}
          {view.truncated ? " · bb cut this diff short" : ""}
        </p>

        {general.length > 0 || generalDraft.active !== null ? (
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
        ) : null}

        {outdated.length > 0 ? (
          <section className="flex flex-col gap-2 border-b border-border px-3 py-2">
            <h3 className="text-xs font-medium text-muted-foreground">Not on the current diff (the code changed or left the view)</h3>
            {outdated.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} placement={{ state: "outdated" }} />
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
          />
        ))}
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
      <AiReviewDialog open={reviewing} onOpenChange={setReviewing} sessionId={view.sessionId} threadId={threadId} environmentId={view.environmentId} onStarted={putRun} />
    </div>
  );
}
