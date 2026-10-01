/**
 * The failing count, as the app sees it: whatever the server last counted,
 * replaced each time it publishes a new one. The server re-counts about once
 * a minute whether or not anything is open (server/health.ts), so this only
 * listens — and asks again after a reconnect, because a publish sent while the
 * window was disconnected is gone.
 */
import { useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";

import { HEALTH_CHANGED, HealthSchema, type Health } from "../shared/channels";
import type { RpcContract } from "../shared/contract";

/** Shared by every mounted reader, so the sidebar row and the panel agree, and a remount starts from it. */
let cached: Health | null = null;

/** Counts the times the realtime connection has come back. */
export function useReconnects(): number {
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (previous.current !== "connected" && state === "connected") setCount((value) => value + 1);
    previous.current = state;
  }, [state]);
  return count;
}

export function useHealth(): Health | null {
  const rpc = useRpc<RpcContract>();
  const reconnects = useReconnects();
  const [health, setHealth] = useState<Health | null>(cached);

  useEffect(() => {
    let live = true;
    rpc
      .call("health", { refresh: false })
      .then((value) => {
        cached = value;
        if (live) setHealth(value);
      })
      .catch((error: unknown) => {
        // A plugin mid-reload: keep the count we have rather than claiming all is well.
        console.warn("[launchd-jobs] could not read the failing count", error);
      });
    return () => {
      live = false;
    };
  }, [rpc, reconnects]);

  useRealtime(HEALTH_CHANGED, (payload) => {
    const parsed = HealthSchema.safeParse(payload);
    if (!parsed.success) return;
    cached = parsed.data;
    setHealth(parsed.data);
  });

  return health;
}

/**
 * The sidebar row's trailing text: "2 failing" while any job's latest run
 * failed unseen, nothing otherwise. The host clips it and hides it on a
 * compact viewport, where the panel's own list carries the same news.
 */
export function FailingAccessory() {
  const health = useHealth();
  const count = health?.failing.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="truncate text-xs font-medium text-destructive" title={health?.failing.map((entry) => entry.name).join(", ")}>
      {count} failing
    </span>
  );
}
