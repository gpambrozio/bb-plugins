/**
 * The Dream page's data: the overview (machine, schedule, projects, the running dream) and the run
 * log, re-read when the server announces a change, when the realtime link comes back (announcements
 * sent while it was down are lost), and every 30 seconds while the page is open.
 */
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { DREAM_CHANGED, type Overview, type RunRecord } from "../shared/contract-types";

const REFRESH_MS = 30_000;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DreamData {
  overview: Overview | null;
  runs: RunRecord[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

export function useDream(): DreamData {
  const rpc = useRpc<RpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    void Promise.all([rpc.call("overview", {}), rpc.call("history", { limit: 100 })])
      .then(([nextOverview, nextRuns]) => {
        if (mine !== generation.current) return;
        setOverview(nextOverview);
        setRuns(nextRuns);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (mine === generation.current) setError(errorText(caught));
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useRealtime(DREAM_CHANGED, () => refresh());

  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(true);
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && !wasConnected.current) refresh();
    wasConnected.current = connected;
  }, [connection, refresh]);

  return { overview, runs, loading, error, refresh };
}
