// GitHub Board — the app entry.
//
// A sidebar page with the board (app/board-panel.tsx), the prompt-template
// editor on the plugin's settings page, and two palette commands.
import { definePluginApp, useBbNavigate, type BbNavigate } from "@get-bb/plugin-sdk/app";

import { BoardPanel, PANEL_PATH, PROMPTS_SUBPATH } from "./app/board-panel";
import { PromptSettingsEditor } from "./app/prompt-settings";

/**
 * A palette command gets no navigation of its own, so this app-wide overlay,
 * mounted once per window, hands the host's navigator to the commands.
 */
let navigator: BbNavigate | null = null;

function NavigatorBridge() {
  navigator = useBbNavigate();
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "GitHub Board",
    icon: "Github",
    path: PANEL_PATH,
    component: BoardPanel,
  });

  app.slots.settingsSection({
    id: "prompts",
    title: "Prompt templates",
    description: "What Send to chat opens with, per column and per project.",
    component: PromptSettingsEditor,
  });

  app.slots.experimental_appOverlay({ id: "navigator", component: NavigatorBridge });

  app.commands.register({
    id: "open-board",
    title: "GitHub Board: open the board",
    run: () => navigator?.toPluginPanel(PANEL_PATH),
  });
  app.commands.register({
    id: "board-settings",
    title: "GitHub Board: edit prompt templates",
    run: () => navigator?.toPluginPanel(PANEL_PATH, { subPath: PROMPTS_SUBPATH }),
  });
});
