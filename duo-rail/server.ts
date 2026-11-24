// duo-rail — the server entry. It only defines the settings the app reads; the rail itself is the
// app overlay in app.tsx, and the button editor is a settings section there.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { DEFAULT_LAYOUT_JSON, layoutProblem } from "./shared/layout";
import { DEFAULT_CAMERA_CLEARANCE, DEFAULT_UNFOLDED_CAMERA_CLEARANCE, MAX_CAMERA_CLEARANCE } from "./shared/placement";
import { CAMERA_CLEARANCE_SETTING, LAYOUT_SETTING, UNFOLDED_CAMERA_CLEARANCE_SETTING } from "./shared/settings";

const clearance = z.number().int().min(0).max(MAX_CAMERA_CLEARANCE);

/**
 * Refuses a layout the app could not draw, with the reason, whoever writes it: the editor or the form.
 * Empty text is the default layout.
 */
const layout = z.string().superRefine((text, ctx) => {
  const problem = text.trim() === "" ? null : layoutProblem(text);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    [CAMERA_CLEARANCE_SETTING]: {
      type: "number",
      label: "Space for the camera, folded (points)",
      description:
        "On the folded cover screen: how far below the top of the screen the buttons start, so they clear the camera and the clock. Raise it if the first button sits under the clock; lower it to move the buttons up.",
      default: DEFAULT_CAMERA_CLEARANCE,
      experimental_schema: clearance,
    },
    [UNFOLDED_CAMERA_CLEARANCE_SETTING]: {
      type: "number",
      label: "Space for the camera, unfolded (points)",
      description: "The same on the unfolded display, where the clock and the status icons take less room.",
      default: DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
      experimental_schema: clearance,
    },
    [LAYOUT_SETTING]: {
      type: "string",
      label: "Button layout (JSON)",
      description:
        "The buttons the Buttons section below edits, as text: copy it to another bb, or paste one here. Clear it to go back to Back, New thread and More.",
      experimental_multiline: true,
      default: DEFAULT_LAYOUT_JSON,
      experimental_schema: layout,
    },
  });
}
