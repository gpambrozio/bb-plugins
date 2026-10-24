/**
 * The Review tab's data: the view from `getReview`, kept fresh by the workspace's realtime channel.
 * A `threads` signal re-reads the session's threads; a `diff` signal (the workspace changed by the end
 * of an agent's turn) reloads the whole view. Signals are not replayed, so a reconnect reloads too.
 *
 * Every update lands in place: whatever came back unchanged keeps its old object, so React and
 * Pierre (which redraws a file's diff whenever its annotations array is a new one) leave it alone,
 * and only the thread an agent answered or the file that changed is drawn again. A patch loaded on
 * demand stays on screen while a reload fetches it again (`stalePatches`), instead of flashing
 * "Loading the diff…".
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { environmentChannel, realtimeSignalSchema, type DiffFile, type ReviewThread, type ReviewView, type Run, type Target, type TargetRequest } from "../shared/types";

export type ReadyView = Extract<ReviewView, { ok: true }>;

export type ReviewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  /**
   * `loadId` changes with every load of the view, so the tab knows its patches were replaced.
   * `stalePatches`: on-demand files still showing the previous load's patch while it loads again.
   */
  | { status: "ready"; view: ReadyView; refreshing: boolean; loadId: number; stalePatches: ReadonlySet<string> };

const NO_PATHS: ReadonlySet<string> = new Set();

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `next`, with each entry that equals the one of the same id in `previous` replaced by that one, and
 * `previous` itself when nothing changed.
 */
export function shareById<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  const shared = next.map((entry) => {
    const old = byId.get(entry.id);
    return old !== undefined && same(old, entry) ? old : entry;
  });
  return shared.length === previous.length && shared.every((entry, index) => entry === previous[index]) ? (previous as T[]) : shared;
}

/**
 * A reloaded view merged into the one on screen: unchanged files, threads and runs keep their objects.
 * An on-demand file whose patch the new load did not send keeps showing the patch it had, marked
 * stale, until the loader fetches it again.
 */
export function mergeView(previous: ReadyView, previousStale: ReadonlySet<string>, next: ReadyView): { view: ReadyView; stale: ReadonlySet<string> } {
  const before = new Map(previous.files.map((file) => [file.path, file]));
  const stale = new Set<string>();
  const files = next.files.map((file): DiffFile => {
    const old = before.get(file.path);
    if (old === undefined) return file;
    if (!previousStale.has(file.path) && same(old, file)) return old;
    if (file.patch === null && old.patch !== null && file.loadMode === "on_demand") {
      stale.add(file.path);
      return { ...file, patch: old.patch, patchTruncated: old.patchTruncated };
    }
    return file;
  });
  const unchangedFiles = files.length === previous.files.length && files.every((file, index) => file === previous.files[index]);
  return {
    view: {
      ...next,
      files: unchangedFiles ? previous.files : files,
      threads: shareById(previous.threads, next.threads),
      runs: shareById(previous.runs, next.runs),
      commits: same(previous.commits, next.commits) ? previous.commits : next.commits,
      ignoredPaths: same(previous.ignoredPaths, next.ignoredPaths) ? previous.ignoredPaths : next.ignoredPaths,
    },
    stale,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `autoTarget`: let the first load replace an empty uncommitted view with the branch's commits (the
 * server decides). `onTarget` is then told the view it landed on, so the caller's picker follows; that
 * view is not loaded a second time.
 */
export function useReview(threadId: string, target: TargetRequest, autoTarget = false, onTarget?: (target: Target) => void) {
  const rpc = useRpc<RpcContract>();
  const [state, setState] = useState<ReviewState>({ status: "loading" });
  // Loads can overlap (a signal during a load); only the latest one lands.
  const generation = useRef(0);
  const targetJson = JSON.stringify(target);
  // Only the very first load may pick the view; any later one, the user's choice included, may not.
  const autoPending = useRef(autoTarget);
  // The target the server already answered for, when it picked it: adopting it needs no new load.
  const adopted = useRef<string | null>(null);
  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const auto = autoPending.current;
    autoPending.current = false;
    setState((previous) => (previous.status === "ready" ? { ...previous, refreshing: true } : { status: "loading" }));
    try {
      const view = await rpc.call("getReview", { threadId, target: JSON.parse(targetJson) as TargetRequest, ...(auto ? { autoTarget: true } : {}) });
      if (mine !== generation.current) return;
      setState((previous) => {
        if (!view.ok) return { status: "unavailable", message: view.message };
        if (previous.status !== "ready" || previous.view.sessionId !== view.sessionId) {
          return { status: "ready", view, refreshing: false, loadId: mine, stalePatches: NO_PATHS };
        }
        const merged = mergeView(previous.view, previous.stalePatches, view);
        return { status: "ready", view: merged.view, refreshing: false, loadId: mine, stalePatches: merged.stale };
      });
      if (view.ok && auto && JSON.stringify(view.target) !== targetJson) {
        adopted.current = JSON.stringify(view.target);
        onTargetRef.current?.(view.target);
      }
    } catch (error) {
      if (mine !== generation.current) return;
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [rpc, threadId, targetJson]);

  useEffect(() => {
    if (adopted.current === targetJson) {
      adopted.current = null;
      return;
    }
    void load();
  }, [load, targetJson]);

  const sessionId = state.status === "ready" ? state.view.sessionId : null;
  const environmentId = state.status === "ready" ? state.view.environmentId : null;

  const refreshThreads = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const { threads, runs } = await rpc.call("listThreads", { sessionId });
      setState((previous) =>
        previous.status === "ready" && previous.view.sessionId === sessionId
          ? { ...previous, view: { ...previous.view, threads: shareById(previous.view.threads, threads), runs: shareById(previous.view.runs, runs) } }
          : previous,
      );
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [rpc, sessionId]);

  /** Puts a thread an RPC returned in place, so the tab does not wait for the realtime signal. */
  const putThread = useCallback((thread: ReviewThread) => {
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== thread.sessionId) return previous;
      const threads = previous.view.threads.some((row) => row.id === thread.id)
        ? previous.view.threads.map((row) => (row.id === thread.id ? thread : row))
        : [...previous.view.threads, thread];
      return { ...previous, view: { ...previous.view, threads } };
    });
  }, []);

  /** Puts a run an RPC returned in place (or first), so the tab does not wait for the signal. */
  const putRun = useCallback((run: Run) => {
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== run.sessionId) return previous;
      const others = previous.view.runs.filter((row) => row.id !== run.id);
      const runs = run.status === "closed" ? others : [run, ...others];
      return { ...previous, view: { ...previous.view, runs } };
    });
  }, []);

  /**
   * Fills in patches loaded on demand for the load `loadId` of session `sessionId`. An answer that
   * arrives after the view changed (another view, or a reload) is dropped: same paths, other diffs.
   */
  const putPatches = useCallback((sessionId: string, loadId: number, patches: readonly { path: string; patch: string; truncated: boolean }[]) => {
    const byPath = new Map(patches.map((patch) => [patch.path, patch]));
    setState((previous) => {
      if (previous.status !== "ready" || previous.view.sessionId !== sessionId || previous.loadId !== loadId) return previous;
      const files = previous.view.files.map((file): DiffFile => {
        const patch = byPath.get(file.path);
        if (patch === undefined || (file.patch === patch.patch && file.patchTruncated === patch.truncated)) return file;
        return { ...file, patch: patch.patch, patchTruncated: patch.truncated };
      });
      const stalePatches = new Set([...previous.stalePatches].filter((path) => !byPath.has(path)));
      return { ...previous, view: { ...previous.view, files }, stalePatches };
    });
  }, []);

  useRealtime(environmentId === null ? "" : environmentChannel(environmentId), (payload) => {
    const signal = realtimeSignalSchema.safeParse(payload);
    if (!signal.success) return;
    if (signal.data.kind === "diff") void load();
    else if (signal.data.sessionId === sessionId) void refreshThreads();
  });

  // Reload when the connection comes back (signals sent while it was down are lost), and only then:
  // a new `load` (another view) is loaded by the effect above.
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (connection === "connected" && previous !== "connected") void loadRef.current();
  }, [connection]);

  return { state, reload: load, putThread, putRun, putPatches, refreshThreads };
}
