import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CommandBridge, PANEL_ACTION_ID, askFirstMate, getStarted, openFirstMate } from "./app/commands";
import { SHIP_ICON } from "./app/icons";
import { BoardOpener, IntroOverlay } from "./app/intro";
import { Panel } from "./app/panel";
import { SettingsSection } from "./app/settings-section";
import { WatchNoteExpander } from "./app/watch-note-expander";

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    id: PANEL_ACTION_ID,
    title: "FirstMate",
    icon: SHIP_ICON,
    layout: "padded",
    context: { kind: "thread" },
    availability: "action",
    component: Panel,
  });
  app.slots.settingsSection({ id: "firstmate", component: SettingsSection });
  app.slots.experimental_appOverlay({ id: "command-bridge", component: CommandBridge });
  app.slots.experimental_appOverlay({ id: "watch-notes", component: WatchNoteExpander });
  app.slots.experimental_appOverlay({ id: "intro", component: IntroOverlay });
  app.composer.customize({ id: "intro-board", scopes: ["thread"], actions: [{ id: "intro-board", component: BoardOpener }] });
  app.commands.register({ id: "open", title: "FirstMate: open", run: openFirstMate });
  app.commands.register({ id: "get-started", title: "FirstMate: get started", run: getStarted });
  app.commands.register({ id: "bearings", title: "FirstMate: bearings", run: () => askFirstMate("bearings") });
});
