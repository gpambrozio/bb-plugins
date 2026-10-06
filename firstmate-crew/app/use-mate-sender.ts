/**
 * Sending the captain's words to the first mate through `mate.ask` and `mate.command`, one at a time
 * (`./send-gate`). A failure is shown as a toast; a refused second press does nothing.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { rpcContract } from "../server";
import { reportError } from "./notify";
import { mateSendGate } from "./send-gate";

/** Runs `task` unless a send is already out; false when refused. `onSent` runs once it lands. */
export function deliverToMate(task: () => Promise<unknown>, onSent?: () => void): boolean {
  const started = mateSendGate.run(task);
  if (started === null) return false;
  started.then(() => onSent?.()).catch(reportError);
  return true;
}

export interface MateSender {
  /** A message to the first mate is on its way; buttons that send wait for it. */
  sending: boolean;
  ask: (text: string, onSent?: () => void) => boolean;
  command: (command: "bearings") => boolean;
}

export function useMateSender(): MateSender {
  const rpc = useRpc<typeof rpcContract>();
  const sending = useSyncExternalStore(mateSendGate.subscribe, mateSendGate.busy);
  return {
    sending,
    ask: (text, onSent) => deliverToMate(() => rpc.call("mate.ask", { text }), onSent),
    command: (command) =>
      deliverToMate(() => rpc.call("mate.command", { command, args: "" }), () => toast.success("Sent to the first mate.")),
  };
}
