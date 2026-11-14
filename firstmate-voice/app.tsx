/**
 * FirstMate voice's app: the pill (an app overlay in every window), the palette command, and a Talk button
 * in the first mate's thread header. All three share one controller per window (`app/controller.ts`).
 */
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "./server";
import { voice } from "./app/controller";
import { VoicePill, useVoiceState } from "./app/overlay";

/** The first mate's thread id, read once and again when the header shows another thread. */
function useMateThread(threadIds: readonly string[]): string | null {
  const rpc = useRpc<typeof rpcContract>();
  const [mate, setMate] = useState<string | null>(null);
  const key = threadIds.join(",");
  useEffect(() => {
    if (key === "") return;
    let live = true;
    rpc
      .call("mate.thread", {})
      .then(({ threadId }) => {
        if (live) setMate(threadId);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rpc, key]);
  return mate;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice", component: VoicePill });

  app.commands.register({
    id: "talk",
    title: "FirstMate voice: talk or end",
    run: () => voice.toggle(),
  });

  app.slots.experimental_threadAction<{ mate: string | null; active: boolean }>({
    id: "talk",
    title: "Talk to the first mate",
    icon: "Mic",
    group: "firstmate-voice",
    placement: "header",
    useData: ({ threadIds }) => {
      const mate = useMateThread(threadIds);
      const state = useVoiceState();
      return { mate, active: state.phase === "connecting" || state.phase === "live" };
    },
    item: ({ thread, data }) =>
      data.mate === null || thread.id !== data.mate
        ? null
        : {
            label: data.active ? "End voice" : "Talk",
            detail: "FirstMate voice",
            icon: "Mic",
            run: () => voice.toggle(),
          },
  });
});
