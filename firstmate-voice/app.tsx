/**
 * FirstMate voice's app: the pill (an app overlay in every window), the palette commands, and a Talk button
 * in the first mate's thread header. All three share one controller per window (`app/controller.ts`). The debug
 * log is a side-panel tab (`app/debug.tsx`), opened from the pill, the palette and the first mate's header menu.
 * The voice hooks, one command per machine, are a section of the plugin's settings (`app/hooks-section.tsx`).
 */
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";

import type { rpcContract } from "./server";
import { voice } from "./app/controller";
import { DebugOpener, DebugTab } from "./app/debug";
import { DEBUG_TAB, openDebugLog } from "./app/debug-view";
import { VoiceHooksSection } from "./app/hooks-section";
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

  app.slots.settingsSection({
    id: "hooks",
    title: "Voice hooks",
    description: "A command per machine, run as listening starts and stops, as the voice speaks and as you talk.",
    component: VoiceHooksSection,
  });

  app.commands.register({
    id: "talk",
    title: "FirstMate voice: talk or end",
    run: () => voice.toggle(),
  });

  // The debug log: a tab in a thread's side panel, beside the chat. Every way in opens it through bb's panel
  // controller; where the focused surface has no thread panel, the thread's composer (`DebugOpener`) or, for
  // no thread at all, the first mate's thread takes the request.
  app.slots.experimental_tab({
    ...DEBUG_TAB,
    title: "Voice debug",
    icon: "Bug",
    tooltip: "FirstMate voice debug log: everything since listening started",
    layout: "flush",
    component: DebugTab,
  });
  app.composer.customize({ id: "debug-opener", scopes: ["thread"], actions: [{ id: "debug-opener", component: DebugOpener }] });

  app.commands.register({
    id: "debug",
    title: "FirstMate voice: debug log",
    run: (context) => openDebugLog(context.experimental_panel, context.threadId),
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

  // A second header action, so the debug log is a tap away on the phone too; bb folds it into the menu.
  app.slots.experimental_threadAction<{ mate: string | null }>({
    id: "debug",
    title: "FirstMate voice debug log",
    icon: "Bug",
    group: "firstmate-voice",
    placement: "header",
    useData: ({ threadIds }) => ({ mate: useMateThread(threadIds) }),
    item: ({ thread, data, experimental_panel }) =>
      data.mate === null || thread.id !== data.mate
        ? null
        : { label: "Voice debug log", detail: "FirstMate voice", icon: "Bug", run: () => openDebugLog(experimental_panel, thread.id) },
  });
});
