/**
 * The reviews across projects and their counts, for the Reviews page, its sidebar badge and a
 * thread's Info row. Each re-reads when any review's threads change (`REVIEWS_CHANNEL`) and when the
 * realtime link comes back, since signals sent while it was down are lost.
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { REVIEWS_CHANNEL, targetKey, type ReviewSummary, type Target } from "../shared/types";

export { parseReviewSubPath, reviewSubPath } from "../shared/routes";

/** Runs `read` now, on every review change and on a reconnect; the latest answer wins. */
function useLiveRead<T>(read: () => Promise<T>, channel: string): { data: T | undefined; error: string | null } {
  const [state, setState] = useState<{ data: T | undefined; error: string | null }>({ data: undefined, error: null });
  const generation = useRef(0);
  const readRef = useRef(read);
  readRef.current = read;
  const refresh = useCallback(() => {
    const mine = ++generation.current;
    readRef.current().then(
      (data) => mine === generation.current && setState({ data, error: null }),
      (error: unknown) => mine === generation.current && setState((previous) => ({ data: previous.data, error: error instanceof Error ? error.message : String(error) })),
    );
  }, []);
  useEffect(() => refresh(), [refresh, channel]);
  useRealtime(channel, () => refresh());
  const connection = useRealtimeConnectionState();
  const last = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && last.current !== "connected") refresh();
    last.current = connection;
  }, [connection, refresh]);
  return state;
}

export function useReviews() {
  const rpc = useRpc<RpcContract>();
  return useLiveRead(async () => (await rpc.call("listReviews", {})).reviews, REVIEWS_CHANNEL);
}

/** Open and all comment threads in one workspace, or in every review with null. */
export function useReviewCounts(environmentId: string | null) {
  const rpc = useRpc<RpcContract>();
  return useLiveRead(() => rpc.call("reviewCounts", environmentId === null ? {} : { environmentId }), REVIEWS_CHANNEL);
}

/** Whether a listed review is the one a subPath names. */
export function isReview(review: ReviewSummary, selected: { threadId: string; target: Target } | null): boolean {
  return selected !== null && review.threadId === selected.threadId && targetKey(review.target) === targetKey(selected.target);
}
