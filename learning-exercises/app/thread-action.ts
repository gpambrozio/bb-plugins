/**
 * "Learning offers" in bb's thread menu (feature #3): On or Off for one thread, the same flag as the
 * banner's "Not in this thread", and undoable. bb calls `useData` once for the app with the threads on
 * screen, so the flags are read in one batch and read again whenever the server says something changed.
 */
import {
  experimental_useRpcQuery,
  type PluginThreadAction,
  type PluginThreadActionDataInput,
  type PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { rpcContract, THREAD_OFFERS_BATCH_MAX } from "../shared/contract";
import { errorText, useLearningRpc } from "./data";

export interface OffersData {
  /** Threads whose offers are off; undefined until the first read answers. */
  off: ReadonlySet<string> | undefined;
  set(threadId: string, on: boolean): Promise<void>;
}

export function useOffersData({ threadIds }: PluginThreadActionDataInput): OffersData {
  const ids = threadIds.slice(0, THREAD_OFFERS_BATCH_MAX);
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "threadOffers", input: { threadIds: [...ids] }, enabled: ids.length > 0 });
  const rpc = useLearningRpc();
  return {
    off: query.data === undefined ? undefined : new Set(query.data.off),
    async set(threadId, on) {
      try {
        await rpc.call("setThreadOffers", { threadId, on });
      } catch (error) {
        toast.error(`Learning Exercises could not change this thread's offers: ${errorText(error)}`);
      }
    },
  };
}

export function offersItem({ thread, data }: PluginThreadActionItemInput<OffersData>): PluginThreadAction | null {
  // Offers are only ever made in top-level threads; the menu says nothing elsewhere.
  if (thread.archivedAt !== null || thread.parentThreadId !== null) return null;
  const on = data.off === undefined ? null : !data.off.has(thread.id);
  return {
    label: "Learning offers",
    ...(on === null ? {} : { detail: on ? "On" : "Off" }),
    icon: "Brain",
    choices: {
      heading: "Learning offers in this thread",
      items: [
        { id: "on", label: "On", selected: on === true },
        { id: "off", label: "Off", selected: on === false },
      ],
    },
    run: async ({ value }) => {
      if (value === "on" || value === "off") await data.set(thread.id, value === "on");
    },
  };
}
