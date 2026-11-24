// The button layout as the server stores it (server/layout-store.ts), read live: the server invalidates
// the read on every save, so every open rail and editor, on every device, reads it again.
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";

import { rpcContract } from "../shared/contract";
import { defaultLayout, type Layout } from "../shared/layout";

export interface StoredLayoutState {
  /** The saved layout; null until the first read answers. */
  layout: Layout | null;
  /** Why the saved layout was not used, or why it could not be read (the default stands in), or null. */
  problem: string | null;
  /** Reads it again now, as after a save. */
  refetch(): Promise<void>;
}

export function useStoredLayout(): StoredLayoutState {
  const read = experimental_useRpcQuery({ contract: rpcContract, method: "layout.get", input: {} });
  const { refetch } = read;
  if (read.data !== undefined) return { layout: read.data.layout, problem: read.data.problem, refetch };
  if (read.error !== null) return { layout: defaultLayout(), problem: `The saved layout could not be read, so the default stands in: ${read.error.message}`, refetch };
  return { layout: null, problem: null, refetch };
}
