// duo-rail — the app entry.
//
// An app overlay: the owner's buttons in the iPhone Duo's empty side strip, below the camera, folded or
// unfolded. It draws nothing anywhere else. And a settings section, where the owner picks the buttons.
// See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { ButtonsEditor } from "./app/editor";
import { DuoRail } from "./app/rail";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rail", component: DuoRail });
  app.slots.settingsSection({
    id: "buttons",
    title: "Buttons",
    description: "Which buttons the rail shows on each display, in what order, and what each one does.",
    component: ButtonsEditor,
  });
});
