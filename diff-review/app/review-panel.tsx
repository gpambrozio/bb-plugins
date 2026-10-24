/**
 * The Review tab beside a thread: that thread's workspace diff, drawn by the plugin with bb's
 * `@pierre/diffs`, with comment threads on lines, ranges, files and the whole diff, and "Send to
 * agent", which hands the open ones to this thread.
 *
 * AI review starts a review run; the runs not yet closed are listed under the toolbar. "Only files with
 * comments" narrows the files to those with a comment thread, for going through a review's findings.
 * "Clear review", shown once the view has threads or runs, deletes them all (after a confirm).
 *
 * A tab opened with `params: { target }` starts on that view; otherwise on the uncommitted changes, or,
 * when there are none, on the changes committed since the base branch.
 */
import { useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useState } from "react";
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
import { FileDiff, placeFileThreads, type DiffStyle } from "./file-diff";
import { usePatchLoader } from "./patch-loader";
import { targetLabel } from "./labels";
import { RunsList } from "./runs-list";
import { SendDialog } from "./send-dialog";
import { ThreadCard } from "./thread-card";
import { errorMessage, useReview, type ReadyView } from "./use-review";

/** The `threadPanelAction` id; the palette command opens it by this. */
export const PANEL_ACTION_ID = "review";

const DIFF_STYLE_KEY = "diff-review:diff-style";
const ONLY_COMMENTED_KEY = "diff-review:only-commented";

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

/** The files a view shows: all of them, or with `onlyCommented` those with a comment thread. */
export function shownFiles<File extends { path: string }>(files: readonly File[], byFile: ReadonlyMap<string, readonly ReviewThread[]>, onlyCommented: boolean): readonly File[] {
  return onlyCommented ? files.filter((file) => (byFile.get(file.path)?.length ?? 0) > 0) : files;
}

function pickerValue(target: TargetRequest): string {
  return target.kind === "commit" ? `commit:${target.sha}` : target.kind;
}

function fromPicker(value: string): TargetRequest {
  if (value.startsWith("commit:")) return { kind: "commit", sha: value.slice("commit:".length) };
  if (value === "branch" || value === "all") return { kind: value };
  return { kind: "uncommitted" };
}

export function ReviewPanel({ threadId, params }: PluginThreadPanelProps) {
  const [target, setTarget] = useState<TargetRequest>(() => initialTarget(params));
  // A tab opened without a view starts on the uncommitted changes, unless there are none and the
  // branch has commits: the first load decides, and the picker follows it.
  const [autoTarget] = useState(() => !hasTarget(params));
  const review = useReview(threadId, target, autoTarget, setTarget);
  const { state } = review;

  const pick = (value: string) => setTarget(fromPicker(value));

  if (state.status === "loading") return <Centered>Loading the diff…</Centered>;
  if (state.status === "unavailable") return <Centered>{state.message}</Centered>;
  if (state.status === "error") {
    return (
      <Centered>
        <span>Could not load the review: {state.message}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void review.reload()}>
          Try again
        </Button>
      </Centered>
    );
  }

  return (
    <ReviewActionsProvider sessionId={state.view.sessionId} threadId={threadId} putThread={review.putThread} refreshThreads={review.refreshThreads}>
      <ReadyPanel
        threadId={threadId}
        view={state.view}
        refreshing={state.refreshing}
        pickerValue={pickerValue(state.view.target.kind === "commit" ? state.view.target : target)}
        onPick={pick}
        onReload={() => void review.reload()}
        loadId={state.loadId}
        putPatches={review.putPatches}
        putRun={review.putRun}
        refreshThreads={review.refreshThreads}
      />
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
  putPatches,
  putRun,
  refreshThreads,
}: {
  threadId: string;
  view: ReadyView;
  refreshing: boolean;
  pickerValue: string;
  onPick(value: string): void;
  onReload(): void;
  loadId: number;
  putPatches(patches: readonly { path: string; patch: string; truncated: boolean }[]): void;
  putRun(run: Run): void;
  refreshThreads(): Promise<void>;
}) {
  const rpc = useRpc<RpcContract>();
  const actions = useActions();
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => (stored(DIFF_STYLE_KEY) === "split" ? "split" : "unified"));
  const [onlyCommented, setOnlyCommented] = useState(() => stored(ONLY_COMMENTED_KEY) === "true");
  const [generalDraft, setGeneralDraft] = useState(false);
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
    store(ONLY_COMMENTED_KEY, String(next));
  };

  const byFile = useMemo(() => {
    const map = new Map<string, ReviewThread[]>();
    for (const thread of view.threads) {
      const list = map.get(thread.filePath) ?? [];
      list.push(thread);
      map.set(thread.filePath, list);
    }
    return map;
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
        const { patches } = await rpc.call("loadPatches", { threadId, target: view.target, paths });
        putPatches(patches);
        return patches.map((patch) => patch.path);
      } catch (error) {
        toast.error(`Could not load ${paths.length === 1 ? `the diff of ${paths[0]}` : `${paths.length} files' diffs`}: ${errorMessage(error)}`);
        throw error;
      }
    },
    [rpc, threadId, view.target, putPatches],
  );
  const patchLoader = usePatchLoader(loadPatches, `${view.sessionId}:${loadId}`);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  // A commit view opened from params may name a commit the branch list does not hold.
  const shown = view.target;
  const orphanCommit = shown.kind === "commit" && !view.commits.some((commit) => commit.sha === shown.sha) ? shown : null;

  const files = shownFiles(view.files, byFile, onlyCommented);
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
        <Button type="button" variant="ghost" size="sm" onClick={onReload} disabled={refreshing} aria-label="Reload the diff">
          <Icon name={refreshing ? "Spinner" : "ArrowReloadHorizontal"} className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setGeneralDraft(true)}>
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

        {general.length > 0 || generalDraft ? (
          <section className="flex flex-col gap-2 border-b border-border px-3 py-2">
            <h3 className="text-xs font-medium text-muted-foreground">About the whole diff</h3>
            {general.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} />
            ))}
            {generalDraft ? (
              <CommentComposer
                placeholder="A comment about the whole change"
                submitLabel="Comment"
                withSeverity
                onSubmit={async ({ body, severity }) => {
                  await actions.create({ filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, anchorContent: null, body, severity });
                  setGeneralDraft(false);
                }}
                onCancel={() => setGeneralDraft(false)}
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

        {view.files.length === 0 ? (
          <Centered>No changes to review here.</Centered>
        ) : files.length === 0 ? (
          <Centered>No file in this view has comments. Turn off "Only files with comments" to see all {view.files.length} files.</Centered>
        ) : null}
        {files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            threads={byFile.get(file.path) ?? []}
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
        onCleared={() => {
          setGeneralDraft(false);
          void refreshThreads();
        }}
      />
      <AiReviewDialog open={reviewing} onOpenChange={setReviewing} sessionId={view.sessionId} threadId={threadId} environmentId={view.environmentId} onStarted={putRun} />
    </div>
  );
}
