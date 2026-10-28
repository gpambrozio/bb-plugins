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

/**
 * Selects the FirstMate tab in the thread in view; false when bb declined. bb 0.48 opens it through the
 * panel controller; bb 0.47 has none, and its `openPanel` (gone from the SDK's types since 0.6.88) takes
 * the tab's id.
 */
export function openTab(context: PluginCommandContext): boolean {
  const panel = (context as Partial<PluginCommandContext>).experimental_panel;
  if (panel !== undefined) {
    return panel.openTab({ tab: { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" } });
  }
  return (context as unknown as LegacyCommandContext).openPanel({ actionId: PANEL_ACTION_ID });
}

/** bb 0.47's command context. */
interface LegacyCommandContext {
  openPanel(options: { actionId: string }): boolean;
}

/** Goes to the first mate's thread, with the FirstMate tab open when this thread already is it. */
export function openFirstMate(context: PluginCommandContext): void {
  withBridge(async ({ rpc, navigate }) => {
    const { mate } = await rpc.call("fleet.load", {});
    if (mate === null) {
      // Nowhere to go: the tab on this thread offers to adopt it, and settings can launch one.
      if (context.threadId === null || !openTab(context)) {
        toast.error("No first mate aboard. Launch one from FirstMate's settings.");
      }
      return;
    }
    if (context.threadId === mate.threadId) openTab(context);
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
