// Herald — the app entry.
//
// A sidebar page listing every thread waiting on you, a banner with the
// sentence above a thread's composer, a thread panel with the sentences of
// its past turns, a settings section for what the host form cannot hold, and
// an app-wide overlay that keeps the list current and speaks each new
// sentence. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { HeraldBanner } from "./app/banner";
import { HeraldBridge } from "./app/bridge";
import { HeraldHistoryPanel } from "./app/history-panel";
import { HERALD_ICONS } from "./app/icons";
import { HeraldPanel, PANEL_PATH, WaitingCount } from "./app/panel";
import { HeraldSettingsSection } from "./app/settings-section";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "waiting",
    title: "Herald",
    icon: HERALD_ICONS.megaphone,
    path: PANEL_PATH,
    component: HeraldPanel,
    experimental_sidebarAccessory: WaitingCount,
  });

  app.slots.experimental_appOverlay({ id: "announcer", component: HeraldBridge });

  app.composer.customize({
    id: "summary",
    scopes: ["thread"],
    banners: [{ id: "summary", component: HeraldBanner }],
  });

  // A sentence per turn, in the thread's side panel: a plugin cannot write into the transcript.
  app.slots.threadPanelAction({ id: "history", title: "Herald", layout: "padded", component: HeraldHistoryPanel });

  app.slots.settingsSection({
    id: "summaries",
    title: "Model-written sentences and voices",
    description: "Which tool writes each sentence and what it is asked, when the switch above is on; and the voices that say it.",
    component: HeraldSettingsSection,
  });
});
