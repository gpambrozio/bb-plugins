/**
 * The Review tab's data: the view from `getReview`, kept fresh by the workspace's realtime channel.
 * A `threads` signal re-reads the session's threads; a `diff` signal (an agent's turn ended in this
 * workspace) reloads the whole view. Signals are not replayed, so a reconnect reloads too.
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { environmentChannel, realtimeSignalSchema, type DiffFile, type ReviewThread, type ReviewView, type Target, type TargetRequest } from "../shared/types";

export type ReadyView = Extract<ReviewView, { ok: true }>;

export type ReviewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  /** `loadId` changes with every load of the view, so the tab knows its patches were replaced. */
  | { status: "ready"; view: ReadyView; refreshing: boolean; loadId: number };

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
      setState(view.ok ? { status: "ready", view, refreshing: false, loadId: mine } : { status: "unavailable", message: view.message });
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
      const { threads } = await rpc.call("listThreads", { sessionId });
      setState((previous) =>
        previous.status === "ready" && previous.view.sessionId === sessionId ? { ...previous, view: { ...previous.view, threads } } : previous,
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

  /** Fills in patches loaded on demand. */
  const putPatches = useCallback((patches: readonly { path: string; patch: string; truncated: boolean }[]) => {
    const byPath = new Map(patches.map((patch) => [patch.path, patch]));
    setState((previous) => {
      if (previous.status !== "ready") return previous;
      const files = previous.view.files.map((file): DiffFile => {
        const patch = byPath.get(file.path);
        return patch === undefined ? file : { ...file, patch: patch.patch, patchTruncated: patch.truncated };
      });
      return { ...previous, view: { ...previous.view, files } };
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

  return { state, reload: load, putThread, putPatches, refreshThreads };
}
