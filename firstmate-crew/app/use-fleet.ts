/**
 * The board's data: `fleet.load` on mount, again whenever the server says the fleet changed (realtime
 * channel "fleet"), when the realtime connection comes back after a drop, and every `refreshSeconds` while
 * a component using it is mounted. Nothing is kept once the last one unmounts.
 */
import { useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Fleet } from "../shared/types";
import type { rpcContract } from "../server";
import { errorText } from "./notify";

const DEFAULT_REFRESH_SECONDS = 10;

export interface FleetState {
  fleet: Fleet | null;
  /** Why the last load failed; cleared by the next one that works. */
  error: string | null;
  reload: () => void;
}

export function useFleet(): FleetState {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);

  const reload = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    rpcRef.current
      .call("fleet.load", {})
      .then((next) => {
        // A slower, older answer must not overwrite a newer one.
        if (!mounted.current || mine !== latest.current) return;
        setFleet(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (mounted.current && mine === latest.current) setError(errorText(caught));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useRealtime("fleet", reload);

  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) reload();
    wasConnected.current = connection === "connected";
  }, [connection, reload]);

  const configured = useSettings().values?.refreshSeconds;
  const seconds = typeof configured === "number" && configured >= 1 ? configured : DEFAULT_REFRESH_SECONDS;
  useEffect(() => {
    const timer = setInterval(reload, seconds * 1000);
    return () => clearInterval(timer);
  }, [reload, seconds]);

  return { fleet, error, reload };
}
