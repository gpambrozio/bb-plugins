// model-pricing — the app entry.
//
// A sidebar page with the pricing table (app/pricing-panel.tsx), and two
// palette commands: one opens the page, one opens its settings.
import { definePluginApp, experimental_usePluginId, useBbNavigate, type BbNavigate } from "@get-bb/plugin-sdk/app";

import { openPluginSettings } from "./app/open-settings";
import { PANEL_PATH, PricingPanel } from "./app/pricing-panel";

/**
 * A palette command gets no navigation of its own, so this app-wide overlay,
 * mounted once per window and rendering nothing, hands the host's navigator
 * and the plugin's id to the commands.
 */
let navigator: BbNavigate | null = null;
let pluginId: string | null = null;

function NavigatorBridge() {
  navigator = useBbNavigate();
  pluginId = experimental_usePluginId();
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pricing",
    title: "Model pricing",
    icon: "ChartColumn",
    path: PANEL_PATH,
    component: PricingPanel,
  });

  app.slots.experimental_appOverlay({ id: "navigator", component: NavigatorBridge });

  app.commands.register({
    id: "open-model-pricing",
    title: "Model pricing: open the price table",
    run: () => navigator?.toPluginPanel(PANEL_PATH),
  });

  app.commands.register({
    id: "model-pricing-settings",
    title: "Model pricing: open settings",
    run: () => {
      if (pluginId !== null) openPluginSettings(window, pluginId);
    },
  });
});
