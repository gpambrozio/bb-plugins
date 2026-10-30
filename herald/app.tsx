// Herald — the app entry.
//
// A sidebar page listing every thread waiting on you, each sentence as a card
// in the thread's timeline (bb 0.48.1; a banner above the composer on older
// bb), a thread panel with the sentences of its past turns,
// a choice in bb's thread menu of what Herald announces for that thread or a
// selection of threads, a settings section for what the host form cannot
// hold, and an app-wide overlay that keeps the list current and speaks each
// new sentence.
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
import { registerTimelineSentences } from "./app/timeline";

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

  // Each sentence as a card above the message that led to it, on bb 0.48.1
  // and newer; an older bb has no such slot and keeps the latest sentence in
  // a banner above the composer, as before.
  if (!registerTimelineSentences(app.slots)) {
    app.composer.customize({
      id: "summary",
      scopes: ["thread"],
      banners: [{ id: "summary", component: HeraldBanner }],
    });
  }

  // The same sentences, newest first, in the thread's side panel.
  app.slots.experimental_tab({
    id: HISTORY_PANEL_ACTION_ID,
    title: "Herald",
    icon: HERALD_ICONS.megaphone,
    layout: "padded",
    context: { kind: "thread" },
    availability: "action",
    component: HeraldHistoryPanel,
  });
  // And the megaphone in the thread header that opens it, a button of its own on every bb.
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
