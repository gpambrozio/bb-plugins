/**
 * Voice Pilot's app. One controller per window (`app/controller.ts`), shared by:
 *
 * - the toast (an app overlay in every window, which holds the call and survives navigation),
 * - the **Voice** page in bb's sidebar (Talk, End, Mute, the state, the voice's staged instructions edit and the
 *   session's log), with a "Live" badge on its entry while a session is up and a pencil while an edit waits,
 * - a **Talk** button in every thread's header (folded into the thread menu on a narrow screen),
 * - the palette commands **Voice Pilot: talk or end** and **Voice Pilot: debug log**.
 *
 * The debug log is also a tab in a thread's side panel (`app/debug.tsx`). The voice hooks (a file on each
 * machine) have a section of the plugin's settings that says which machines have one (`app/hooks-section.tsx`).
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { voice, type VoiceState } from "./app/controller";
import { DebugOpener, DebugTab } from "./app/debug";
import { DEBUG_TAB, openDebugLog } from "./app/debug-view";
import { HookEditor } from "./app/hook-editor";
import { HOOK_EDITOR_ID } from "./app/hook-file";
import { VoiceHooksSection } from "./app/hooks-section";
import { VOICE_PAGE, VoicePill, useVoiceState } from "./app/overlay";
import { VoicePage } from "./app/page";
import { useStagedEdit } from "./app/prompt-edit";
import { withPencil } from "./app/prompt-edit-view";

/** The sidebar entry's badge: "Live" while a session is up, "Paused" while bb was off the phone's screen. */
export function liveBadge(state: VoiceState) {
  if (state.phase === "live") return { text: "Live", tone: "neutral" as const, label: "Voice Pilot is listening" };
  if (state.phase === "paused") return { text: "Paused", tone: "neutral" as const, label: "Voice Pilot is paused" };
  if (state.phase === "connecting" || state.phase === "resuming") return { text: "…", tone: "neutral" as const, label: "Voice Pilot is connecting" };
  return null;
}

/** The session's badge, with a pencil after it while an edit of the voice's instructions waits for review. */
function useLiveBadge() {
  const voiceBadge = liveBadge(useVoiceState());
  return withPencil(voiceBadge, useStagedEdit().staged !== null);
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice", component: VoicePill });

  app.slots.navPanel({ id: "voice", title: "Voice", icon: "Mic", path: VOICE_PAGE, component: VoicePage, experimental_useBadge: useLiveBadge });

  app.slots.settingsSection({
    id: "hooks",
    title: "Voice hooks",
    description: "A file on each machine, run as listening starts and stops, as the voice speaks and as you talk.",
    component: VoiceHooksSection,
  });

  // The hook editor: a file opener no extension selects, named by the settings' Open the script. Older bb has
  // no file openers, and the settings then open the script in bb's own (read-only) preview.
  if ("fileOpener" in app.slots) {
    app.slots.fileOpener({ id: HOOK_EDITOR_ID, title: "Voice hook editor", extensions: [], component: HookEditor });
  }

  app.commands.register({ id: "talk", title: "Voice Pilot: talk or end", run: () => voice.toggle() });

  // The debug log: a tab in a thread's side panel, beside the chat. Where the focused surface has no thread
  // panel, the thread's composer (`DebugOpener`) or, with no thread at all, the Voice page takes the request.
  app.slots.experimental_tab({
    ...DEBUG_TAB,
    title: "Voice debug",
    icon: "Bug",
    tooltip: "Voice Pilot debug log: everything since listening started",
    layout: "flush",
    component: DebugTab,
  });
  app.composer.customize({ id: "debug-opener", scopes: ["thread"], actions: [{ id: "debug-opener", component: DebugOpener }] });
  app.commands.register({
    id: "debug",
    title: "Voice Pilot: debug log",
    run: (context) => openDebugLog(context.experimental_panel, context.threadId),
  });

  app.slots.experimental_threadAction<{ active: boolean }>({
    id: "talk",
    title: "Talk to Voice Pilot",
    icon: "Mic",
    group: "voice-pilot",
    placement: "header",
    useData: () => {
      const state = useVoiceState();
      return { active: state.phase !== "idle" && state.phase !== "ending" };
    },
    item: ({ data }) => ({ label: data.active ? "End voice" : "Talk", detail: "Voice Pilot", icon: "Mic", run: () => voice.toggle() }),
  });

  app.slots.experimental_threadAction({
    id: "debug",
    title: "Voice Pilot debug log",
    icon: "Bug",
    group: "voice-pilot",
    placement: "header",
    useData: () => null,
    item: ({ thread, experimental_panel }) => ({ label: "Voice debug log", detail: "Voice Pilot", icon: "Bug", run: () => openDebugLog(experimental_panel, thread.id) }),
  });
});
