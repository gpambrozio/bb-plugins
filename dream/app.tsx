// Dream — the app entry.
//
// The Dream page in the sidebar (app/dream-page.tsx), with a badge counting the dry runs waiting for
// review (app/waiting-badge.ts), and the part of the plugin's settings the
// host-rendered form cannot hold: the dream machine and the model (app/settings-section.tsx).
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { DreamPage, PANEL_PATH } from "./app/dream-page";
import { DreamSettingsSection } from "./app/settings-section";
import { useWaitingBadge } from "./app/waiting-badge";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "dream", title: "Dream", icon: "Brain", path: PANEL_PATH, component: DreamPage, experimental_useBadge: useWaitingBadge });
  app.slots.settingsSection({
    id: "machine-and-model",
    title: "Dream machine and model",
    description: "Where dreams run, and the Claude Code model they use.",
    component: DreamSettingsSection,
  });
});
