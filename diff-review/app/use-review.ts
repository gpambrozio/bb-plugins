/**
 * The Review tab's data: the view from `getReview`, kept fresh by the workspace's realtime channel.
 * A `threads` signal re-reads the session's threads; a `diff` signal (an agent's turn ended in this
 * workspace) reloads the whole view. Signals are not replayed, so a reconnect reloads too.
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { environmentChannel, realtimeSignalSchema, type DiffFile, type ReviewThread, type ReviewView, type TargetRequest } from "../shared/types";

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

export function useReview(threadId: string, target: TargetRequest) {
  const rpc = useRpc<RpcContract>();
  const [state, setState] = useState<ReviewState>({ status: "loading" });
  // Loads can overlap (a signal during a load); only the latest one lands.
  const generation = useRef(0);
  const targetJson = JSON.stringify(target);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState((previous) => (previous.status === "ready" ? { ...previous, refreshing: true } : { status: "loading" }));
    try {
      const view = await rpc.call("getReview", { threadId, target: JSON.parse(targetJson) as TargetRequest });
      if (mine !== generation.current) return;
      setState(view.ok ? { status: "ready", view, refreshing: false, loadId: mine } : { status: "unavailable", message: view.message });
    } catch (error) {
      if (mine !== generation.current) return;
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [rpc, threadId, targetJson]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const connection = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) void load();
    seenConnected.current = true;
  }, [connection, load]);

  return { state, reload: load, putThread, putPatches, refreshThreads };
}
