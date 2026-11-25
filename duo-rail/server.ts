// duo-rail — the server entry. It defines the two camera-gap settings and keeps the button layout in the
// plugin's own storage, behind the RPCs the rail and the Buttons editor use (shared/contract.ts). The
// rail itself is the app overlay in app.tsx, and the editor a settings section there.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { LAYOUT_TAG, rpcContract } from "./shared/contract";
import { DEFAULT_CAMERA_CLEARANCE, DEFAULT_UNFOLDED_CAMERA_CLEARANCE, MAX_CAMERA_CLEARANCE } from "./shared/placement";
import { CAMERA_CLEARANCE_SETTING, DEBUG_SETTING, DEFAULT_SHOW_DEBUG, UNFOLDED_CAMERA_CLEARANCE_SETTING } from "./shared/settings";
import { createLayoutStore, LEGACY_LAYOUT_SETTING } from "./server/layout-store";

const clearance = z.number().int().min(0).max(MAX_CAMERA_CLEARANCE);

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    [CAMERA_CLEARANCE_SETTING]: {
      type: "number",
      label: "Space for the camera, folded (points)",
      description:
        "On the folded cover screen: how far below the top of the screen the buttons may reach, so they stay clear of the camera and the clock. The buttons stand at the bottom of the strip; when they would reach higher than this, the rail is hidden.",
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
    [DEBUG_SETTING]: {
      type: "boolean",
      label: "Show debug numbers",
      description: "Small text above the top button with the screen's safe-area insets and sizes, updated live. A temporary aid.",
      default: DEFAULT_SHOW_DEBUG,
    },
  });

  const store = createLayoutStore({
    kv: bb.storage.kv,
    readLegacy: async () => (await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId })).values[LEGACY_LAYOUT_SETTING],
    dropLegacy: async () => {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { [LEGACY_LAYOUT_SETTING]: null } });
    },
    changed: () => void bb.rpc.experimental_invalidate([LAYOUT_TAG]),
    log: bb.log,
  });

  bb.rpc.register(rpcContract, {
    "layout.get": () => store.get(),
    "layout.set": async ({ layout }) => ({ layout: await store.set(layout) }),
  });
}
