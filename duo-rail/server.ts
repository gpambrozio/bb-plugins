// duo-rail — the server entry. It only defines the setting the app reads; the rail itself is the
// app overlay in app.tsx.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { DEFAULT_CAMERA_CLEARANCE, MAX_CAMERA_CLEARANCE } from "./shared/placement";
import { CAMERA_CLEARANCE_SETTING } from "./shared/settings";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    [CAMERA_CLEARANCE_SETTING]: {
      type: "number",
      label: "Space for the camera (points)",
      description:
        "How far below the top of the screen the buttons start, so they clear the camera and the clock. Raise it if the first button sits under the clock; lower it to move the buttons up.",
      default: DEFAULT_CAMERA_CLEARANCE,
      experimental_schema: z.number().int().min(0).max(MAX_CAMERA_CLEARANCE),
    },
  });
}
