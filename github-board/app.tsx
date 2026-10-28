// GitHub Board — the app entry.
//
// A sidebar page with the board (app/board-panel.tsx), the prompt-template
// editor on the plugin's settings page, two palette commands, and the card a
// thread was started on in its Info tab and on its sidebar row
// (app/thread-card-slots.tsx).
import { definePluginApp, useBbNavigate, type BbNavigate } from "@get-bb/plugin-sdk/app";

import { BoardPanel, boardPageTitle, PANEL_PATH, PROMPTS_SUBPATH } from "./app/board-panel";
import { PromptSettingsEditor } from "./app/prompt-settings";
import { PendingAddToChat } from "./app/pending-add-delivery";
import { BoardPatchListener } from "./app/state";
import { registerThreadCard } from "./app/thread-card-slots";

/**
 * A palette command gets no navigation of its own, so this app-wide overlay,
 * mounted once per window, hands the host's navigator to the commands. It also
 * keeps the remembered board current while no board is on screen, and adds a
 * card to a chat that Add to chat opened, once the chat is on screen.
 */
let navigator: BbNavigate | null = null;

function AppBridge() {
  navigator = useBbNavigate();
  return (
    <>
      <BoardPatchListener />
      <PendingAddToChat />
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "GitHub Board",
    icon: "Github",
    path: PANEL_PATH,
    component: BoardPanel,
    experimental_usePageTitle: boardPageTitle,
  });

  app.slots.settingsSection({
    id: "prompts",
    title: "Prompt templates",
    description: "What Send to chat opens with, per column and per project.",
    component: PromptSettingsEditor,
  });

  app.slots.experimental_appOverlay({ id: "bridge", component: AppBridge });

  registerThreadCard(app.slots);

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
