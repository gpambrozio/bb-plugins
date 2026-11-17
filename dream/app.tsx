// Dream — the app entry.
//
// The Dream page in the sidebar (app/dream-page.tsx), and the part of the plugin's settings the
// host-rendered form cannot hold: the dream machine and the model (app/settings-section.tsx).
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { DreamPage, PANEL_PATH } from "./app/dream-page";
import { DreamSettingsSection } from "./app/settings-section";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "dream", title: "Dream", icon: "Brain", path: PANEL_PATH, component: DreamPage });
  app.slots.settingsSection({
    id: "machine-and-model",
    title: "Dream machine and model",
    description: "Where dreams run, and the Claude Code model they use.",
    component: DreamSettingsSection,
  });
});
