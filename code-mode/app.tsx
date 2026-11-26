// code-mode — the app entry. "Send in Code Mode" in the new-thread composer's Send menu, the badge and
// the thread-menu line that show a thread is in Code Mode, and the switches on the plugin's settings
// page. Everything is decided on the server; the app only asks and shows.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { sendInCodeMode } from "./app/send-menu";
import { SettingsSection } from "./app/settings-section";
import { menuLine, rowBadge } from "./app/thread-ui";

export default definePluginApp((app) => {
  app.composer.customize({ id: "code-mode", scopes: ["new-thread"], sendMenu: [sendInCodeMode] });
  app.slots.experimental_threadRowMetadata(rowBadge);
  app.slots.experimental_threadAction(menuLine);
  app.slots.settingsSection({
    id: "switches",
    title: "Where Code Mode runs",
    description: "Machines that may run Code Mode, and projects whose new threads start in it.",
    component: SettingsSection,
  });
});
