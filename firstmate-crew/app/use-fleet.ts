/**
 * The board's data: `fleet.load` through bb's shared query cache. bb reads it again when the server
 * invalidates the `fleet` tag (on every change it sees, and every `refreshSeconds` while some board is
 * open, see `server.ts`), and after a dropped connection comes back; it shares one read between the
 * components that ask for it. A disabled read (a hidden tab) is not watched, so it costs nothing until it
 * is enabled again, and is then read afresh.
 */
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef } from "react";

import { rpcContract } from "../shared/contract";
import type { Fleet } from "../shared/types";
import { errorText } from "./notify";

export interface FleetState {
  fleet: Fleet | null;
  /** Why the last load failed; cleared by the next one that works. */
  error: string | null;
  reload: () => void;
}

/** `enabled` is false while the board cannot be seen; the last fleet it loaded stays meanwhile. */
export function useFleet(enabled: boolean): FleetState {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "fleet.load", input: {}, enabled });
  const { refetch } = query;
  const reload = useCallback(() => void refetch(), [refetch]);

  // Shown again: whatever changed while hidden is read now, not at the next invalidation.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabled.current) reload();
    wasEnabled.current = enabled;
  }, [enabled, reload]);

  return { fleet: query.data ?? null, error: query.error === null ? null : errorText(query.error), reload };
}
