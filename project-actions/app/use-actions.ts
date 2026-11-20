// A thread's actions as the app shows them, and starting one: the server starts (or finds) its
// terminal, and bb's terminal panel shows it.
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import type { RpcContract } from "../shared/contract";
import type { ActionsList } from "../shared/views";

export type ActionsState = { kind: "loading" } | { kind: "loaded"; list: ActionsList } | { kind: "failed"; message: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useProjectActions(threadId: string) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<ActionsState>({ kind: "loading" });
  // Only the latest load may land, so a slow read cannot replace a newer one.
  const generation = useRef(0);

  const load = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    setState((current) => (current.kind === "loaded" ? current : { kind: "loading" }));
    rpc.call("list", { threadId }).then(
      (list) => {
        if (generation.current === mine) setState({ kind: "loaded", list });
      },
      (error: unknown) => {
        if (generation.current === mine) setState({ kind: "failed", message: message(error) });
      },
    );
  }, [rpc, threadId]);

  const run = useCallback(
    async (name: string) => {
      try {
        const { terminalId } = await rpc.call("run", { threadId, name });
        const shown = await navigate.experimental_openTerminal({ terminalId });
        // bb refuses an exited terminal: the action ended before it could be shown.
        if (!shown) toast.error(`"${name}" started, but bb could not show its terminal. Open it from the thread's terminal panel.`);
      } catch (error) {
        toast.error(`"${name}" did not start`, { description: message(error) });
      }
    },
    [navigate, rpc, threadId],
  );

  return { state, load, run };
}
