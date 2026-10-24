/**
 * The Review tab beside a thread: that thread's workspace diff, drawn by the plugin with bb's
 * `@pierre/diffs`, with comment threads on lines, ranges, files and the whole diff, and "Send to
 * agent", which hands the open ones to this thread.
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

import type { RpcContract } from "../shared/contract";
import { GENERAL_PATH, targetRequestSchema, type ReviewThread, type TargetRequest } from "../shared/types";
import { ReviewActionsProvider, useActions } from "./actions";
import { CommentComposer } from "./comment-composer";
import { FileDiff, placeFileThreads, type DiffStyle } from "./file-diff";
import { usePatchLoader } from "./patch-loader";
import { targetLabel } from "./labels";
import { SendDialog } from "./send-dialog";
import { ThreadCard } from "./thread-card";
import { errorMessage, useReview, type ReadyView } from "./use-review";

/** The `threadPanelAction` id; the palette command opens it by this. */
export const PANEL_ACTION_ID = "review";

const DIFF_STYLE_KEY = "diff-review:diff-style";

function initialTarget(params: unknown): TargetRequest {
  const parsed = targetRequestSchema.safeParse((params as { target?: unknown } | null)?.target);
  return parsed.success ? parsed.data : { kind: "uncommitted" };
}

function hasTarget(params: unknown): boolean {
  return targetRequestSchema.safeParse((params as { target?: unknown } | null)?.target).success;
}

function storedDiffStyle(): DiffStyle {
  try {
    return window.localStorage.getItem(DIFF_STYLE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
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
    <ReviewActionsProvider sessionId={state.view.sessionId} putThread={review.putThread} refreshThreads={review.refreshThreads}>
      <ReadyPanel
        threadId={threadId}
        view={state.view}
        refreshing={state.refreshing}
        pickerValue={pickerValue(state.view.target.kind === "commit" ? state.view.target : target)}
        onPick={pick}
        onReload={() => void review.reload()}
        loadId={state.loadId}
        putPatches={review.putPatches}
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
}: {
  threadId: string;
  view: ReadyView;
  refreshing: boolean;
  pickerValue: string;
  onPick(value: string): void;
  onReload(): void;
  loadId: number;
  putPatches(patches: readonly { path: string; patch: string; truncated: boolean }[]): void;
}) {
  const rpc = useRpc<RpcContract>();
  const actions = useActions();
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(storedDiffStyle);
  const [generalDraft, setGeneralDraft] = useState(false);
  const [sending, setSending] = useState(false);

  const toggleStyle = () => {
    const next = diffStyle === "split" ? "unified" : "split";
    setDiffStyle(next);
    try {
      window.localStorage.setItem(DIFF_STYLE_KEY, next);
    } catch {
      // A browser without storage just forgets the choice.
    }
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

  const additions = view.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = view.files.reduce((sum, file) => sum + file.deletions, 0);

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
        <Button type="button" variant="ghost" size="sm" onClick={onReload} disabled={refreshing} aria-label="Reload the diff">
          <Icon name={refreshing ? "Spinner" : "ArrowReloadHorizontal"} className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => setGeneralDraft(true)}>
          <Icon name="MessageSquarePlus" className="size-4" />
          Comment on the diff
        </Button>
        <Button type="button" size="sm" className="ml-auto gap-1" onClick={() => setSending(true)} disabled={open.length === 0}>
          <Icon name="Sent" className="size-4" />
          Send to agent{open.length === 0 ? "" : ` (${open.length})`}
        </Button>
      </div>

      <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {view.files.length} file{view.files.length === 1 ? "" : "s"} · +{additions} −{deletions}
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

        {view.files.length === 0 ? <Centered>No changes to review here.</Centered> : null}
        {view.files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            threads={byFile.get(file.path) ?? []}
            diffStyle={diffStyle}
            patchState={patchLoader.states.get(file.path)}
            requestPatch={patchLoader.request}
            scrollRoot={scrollRoot}
          />
        ))}
      </div>

      <SendDialog open={sending} onOpenChange={setSending} sessionId={view.sessionId} threadId={threadId} threads={open} />
    </div>
  );
}
