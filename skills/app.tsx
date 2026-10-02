// skills — the app entry.
//
// A Skills tab in each thread's side panel, a Skills button with a live count
// in the thread composer that opens the same browser in a popover, and a
// command-palette entry that opens the tab. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { SkillsComposerButton } from "./app/composer-button";
import { SKILLS_ICON } from "./app/icons";
import { PANEL_ACTION_ID, SkillsPanel } from "./app/panel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Skills",
    icon: SKILLS_ICON,
    layout: "padded",
    component: SkillsPanel,
  });

  app.composer.customize({
    id: "skills",
    scopes: ["thread"],
    actions: [{ id: "skills", component: SkillsComposerButton }],
  });

  app.commands.register({
    id: "open",
    title: "Skills: show this thread's skills",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      context.openPanel({ actionId: PANEL_ACTION_ID });
    },
  });
});
