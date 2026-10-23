// launchd-jobs — the app entry.
//
// A sidebar page with the jobs (app/jobs-panel.tsx), whose sidebar entry
// carries how many jobs are failing, and a palette command that opens it.
import { definePluginApp, useBbNavigate, type BbNavigate } from "@get-bb/plugin-sdk/app";

import { useFailingBadge } from "./app/health";
import { JobsPanel, PANEL_PATH } from "./app/jobs-panel";

/**
 * A palette command gets no navigation of its own, so this app-wide overlay,
 * mounted once per window and rendering nothing, hands the host's navigator
 * to the command.
 */
let navigator: BbNavigate | null = null;

function NavigatorBridge() {
  navigator = useBbNavigate();
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "jobs",
    title: "Scheduled jobs",
    icon: "TimeSchedule",
    path: PANEL_PATH,
    component: JobsPanel,
    // The entry's own title and icon are static; the count is its badge.
    experimental_useBadge: useFailingBadge,
  });

  app.slots.experimental_appOverlay({ id: "navigator", component: NavigatorBridge });

  app.commands.register({
    id: "open-jobs",
    title: "Scheduled jobs: open launchd jobs",
    run: () => navigator?.toPluginPanel(PANEL_PATH),
  });
});
