// Each thread's Code Mode state, for the row badge and the thread menu. bb calls both registrations'
// `useData` once for the whole app, with every thread on screen; the keyed query reads the ones it has
// not read yet in one batch, and reads a thread again when the server writes its record.
import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";

import { rpcContract } from "../shared/contract";
import type { ThreadState } from "../shared/record";

export type ThreadStates = Readonly<Record<string, ThreadState>>;

export function useThreadStates(threadIds: readonly string[]): ThreadStates {
  const keys = useMemo(() => [...new Set(threadIds)].sort(), [threadIds]);
  const query = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "threads.state",
    keys,
    enabled: keys.length > 0,
    select: (rows) => Object.fromEntries(Object.entries(rows).map(([threadId, row]) => [threadId, row.state])) as Record<string, ThreadState>,
  });
  return query.data ?? {};
}
