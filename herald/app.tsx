// Herald — the app entry.
//
// A sidebar page listing every thread waiting on you, a banner with the
// sentence above a thread's composer, a thread panel with the sentences of
// its past turns, a choice in bb's thread menu of what Herald announces for
// that thread or a selection of threads, a settings section for what the
// host form cannot hold, and an app-wide overlay that keeps the list current
// and speaks each new sentence.
// See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { HeraldBanner } from "./app/banner";
import { HAS_PANEL_CONTROLLER } from "./app/bb-features";
import { HeraldBridge } from "./app/bridge";
import { HISTORY_PANEL_ACTION_ID, registerHistoryOpener } from "./app/header-action";
import { HeraldHistoryPanel } from "./app/history-panel";
import { HERALD_ICONS } from "./app/icons";
import { HeraldPanel, PANEL_PATH, useWaitingBadge } from "./app/panel";
import { HeraldSettingsSection } from "./app/settings-section";
import { THREAD_CHOICE_ACTION } from "./app/thread-action";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "waiting",
    title: "Herald",
    icon: HERALD_ICONS.megaphone,
    path: PANEL_PATH,
    component: HeraldPanel,
    experimental_useBadge: useWaitingBadge,
  });

  app.slots.experimental_appOverlay({ id: "announcer", component: HeraldBridge });

  app.composer.customize({
    id: "summary",
    scopes: ["thread"],
    banners: [{ id: "summary", component: HeraldBanner }],
  });

  // A sentence per turn, in the thread's side panel: a plugin cannot write into the transcript.
  app.slots.experimental_tab({
    id: HISTORY_PANEL_ACTION_ID,
    title: "Herald",
    icon: HERALD_ICONS.megaphone,
    layout: "padded",
    context: { kind: "thread" },
    availability: "action",
    component: HeraldHistoryPanel,
  });
  // And a button in the thread header that opens it: "Herald" on bb 0.48, a megaphone before.
  registerHistoryOpener(app.slots, HAS_PANEL_CONTROLLER);

  // Announce, Questions only or Silent, per thread — or for every selected
  // thread at once — beside bb's own notification level.
  app.slots.experimental_threadAction(THREAD_CHOICE_ACTION);

  app.slots.settingsSection({
    id: "summaries",
    title: "Model-written sentences and voices",
    description: "Which tool writes each sentence and what it is asked, when the switch above is on; and the voices that say it.",
    component: HeraldSettingsSection,
  });
});
