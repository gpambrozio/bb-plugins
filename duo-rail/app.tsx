// duo-rail — the app entry.
//
// One app overlay: bb's controls in the folded iPhone Duo's empty side strip, below the camera.
// It draws nothing anywhere else. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { DuoRail } from "./app/rail";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rail", component: DuoRail });
});
