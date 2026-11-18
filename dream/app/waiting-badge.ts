/**
 * The badge on Dream's sidebar entry: how many dry runs wait to be applied or discarded, with their
 * projects in the label, or no badge when none waits. bb calls `useWaitingBadge` in the plugin's scope
 * (`experimental_useBadge`), whatever page is open.
 *
 * Cheap and current without a poll: the count is one read of the proposal folders on the dream machine
 * (the `waiting` RPC), asked once when the app loads, again whenever the server announces a change (a
 * run that ended, an apply, a discard: all go through the server, which publishes `DREAM_CHANGED`), and
 * after the realtime link comes back, since an announcement sent while it was down is lost. No timer, so
 * the badge never keeps the dream machine's worker awake.
 */
import { useRealtime, useRealtimeConnectionState, useRpc, type ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";

import type { RpcContract } from "../shared/contract";
import { DREAM_CHANGED, type WaitingProposal } from "../shared/contract-types";

/** Shared by every mounted reader, so a remount starts from the last count. */
let cached: WaitingProposal[] | null = null;

export function useWaiting(): WaitingProposal[] | null {
  const rpc = useRpc<RpcContract>();
  const [waiting, setWaiting] = useState<WaitingProposal[] | null>(cached);
  const [asks, setAsks] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    rpc
      .call("waiting", {})
      .then((value) => {
        if (mine !== generation.current) return;
        cached = value;
        setWaiting(value);
      })
      .catch((error: unknown) => {
        // A plugin mid-reload: keep the count we have rather than clearing the badge.
        console.warn("[dream] could not count the waiting dry runs", error);
      });
  }, [rpc, asks]);

  useRealtime(DREAM_CHANGED, () => setAsks((value) => value + 1));

  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(true);
  useEffect(() => {
    const connected = connection === "connected";
    if (connected && !wasConnected.current) setAsks((value) => value + 1);
    wasConnected.current = connected;
  }, [connection]);

  return waiting;
}

/** The badge for `waiting`: its count, the projects in the label, or null when none waits. */
export function waitingBadge(waiting: readonly WaitingProposal[] | null): ExperimentalBadge | null {
  if (waiting === null || waiting.length === 0) return null;
  const names = waiting.map((proposal) => proposal.projectName).join(", ");
  const label = waiting.length === 1 ? `1 dry run waiting for review: ${names}` : `${waiting.length} dry runs waiting for review: ${names}`;
  return { count: waiting.length, tone: "warning", label };
}

export function useWaitingBadge(): ExperimentalBadge | null {
  return waitingBadge(useWaiting());
}
