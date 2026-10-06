import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CommandBridge, PANEL_ACTION_ID, askFirstMate, openFirstMate } from "./app/commands";
import { Panel } from "./app/panel";
import { SettingsSection } from "./app/settings-section";
import { WatchNoteExpander } from "./app/watch-note-expander";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: PANEL_ACTION_ID, title: "FirstMate", layout: "padded", component: Panel });
  app.slots.settingsSection({ id: "firstmate", component: SettingsSection });
  app.slots.experimental_appOverlay({ id: "command-bridge", component: CommandBridge });
  app.slots.experimental_appOverlay({ id: "watch-notes", component: WatchNoteExpander });
  app.commands.register({ id: "open", title: "FirstMate: open", run: openFirstMate });
  app.commands.register({ id: "bearings", title: "FirstMate: bearings", run: () => askFirstMate("bearings") });
});
