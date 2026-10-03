// skills — the app entry.
//
// A Skills tab in each thread's side panel, a Skills button with a live count
// in the thread composer that opens the same browser in bb's composer popup, a
// composer command (bindable to a key) that opens that popup, and a
// command-palette entry that opens the tab. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { SkillsComposerButton } from "./app/composer-button";
import { SKILLS_POPUP_ID, SkillsPopup, toggleSkillsPopup } from "./app/composer-popup";
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
    experimental_popups: [{ id: SKILLS_POPUP_ID, label: "Skills", component: SkillsPopup }],
  });

  // No default key: a default that clashes with another is left unbound, and
  // one that clashes with nothing bb knows of can still take a key from the
  // system. It is in the palette, and Settings binds it.
  app.composer.experimental_registerCommand({
    id: "browse",
    title: "Skills: browse this thread's skills",
    run: ({ composer }) => toggleSkillsPopup(composer),
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
