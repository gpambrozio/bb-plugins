/**
 * The command palette's FirstMate commands. A command's `run` is a plain function with no hooks, so it
 * cannot reach the RPC client or navigation itself. `CommandBridge`, an app-wide overlay that draws
 * nothing, hands it those for as long as the app is open.
 */
import { useBbNavigate, useRpc, type BbNavigate, type PluginCommandContext } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { toast } from "sonner";

import type { rpcContract } from "../server";
import { reportError } from "./notify";
import { deliverToMate } from "./use-mate-sender";

export const PANEL_ACTION_ID = "firstmate";

interface Bridge {
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  navigate: BbNavigate;
}

let bridge: Bridge | null = null;

export function CommandBridge(): null {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  useEffect(() => {
    bridge = { rpc, navigate };
    return () => {
      bridge = null;
    };
  }, [rpc, navigate]);
  return null;
}

function withBridge(work: (ready: Bridge) => Promise<void>): void {
  if (bridge === null) {
    toast.error("FirstMate is not ready yet; try again in a moment.");
    return;
  }
  work(bridge).catch(reportError);
}

/** Goes to the first mate's thread, with the FirstMate tab open when this thread already is it. */
export function openFirstMate(context: PluginCommandContext): void {
  withBridge(async ({ rpc, navigate }) => {
    const { mate } = await rpc.call("fleet.load", {});
    if (mate === null) {
      // Nowhere to go: the tab on this thread offers to adopt it, and settings can launch one.
      if (context.threadId === null || !context.openPanel({ actionId: PANEL_ACTION_ID })) {
        toast.error("No first mate aboard. Launch one from FirstMate's settings.");
      }
      return;
    }
    if (context.threadId === mate.threadId) context.openPanel({ actionId: PANEL_ACTION_ID });
    else navigate.toThread(mate.threadId);
  });
}

/** Asks the first mate for its bearings, as the board's button does. */
export function askFirstMate(command: "bearings"): void {
  withBridge(async ({ rpc }) => {
    // One message at a time with the board's buttons, so a double press sends it once.
    deliverToMate(() => rpc.call("mate.command", { command, args: "" }), () => toast.success("Sent to the first mate."));
  });
}
