// screen-sharing — the app entry.
//
// A sidebar page with the screen of the Mac running the bb server
// (app/screen-panel.tsx), whose sidebar row says "Live" while any session is
// open; a pill in every window's corner offering Close all while one is; and a
// palette command that opens the page.
import { definePluginApp, useBbNavigate, type BbNavigate } from "@get-bb/plugin-sdk/app";

import { ScreenPanel, SessionsHeader } from "./app/screen-panel";
import { LiveAccessory, LiveSessionsOverlay, PANEL_PATH } from "./app/sessions";

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
    id: "screen",
    title: "Screen Sharing",
    icon: "screen-sharing/screen-share",
    path: PANEL_PATH,
    component: ScreenPanel,
    headerContent: SessionsHeader,
    experimental_sidebarAccessory: LiveAccessory,
  });

  app.slots.experimental_appOverlay({ id: "live-sessions", component: LiveSessionsOverlay });
  app.slots.experimental_appOverlay({ id: "navigator", component: NavigatorBridge });

  app.commands.register({
    id: "open-screen-sharing",
    title: "Screen Sharing: open the server Mac's screen",
    run: () => navigator?.toPluginPanel(PANEL_PATH),
  });
});
