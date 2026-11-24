// Setting keys, shared by the server (which defines them) and the app (which reads them). No SDK import.
// The button layout is not a setting: it lives in the plugin's storage (shared/contract.ts).
import type { Display } from "./layout";
import { DEFAULT_CAMERA_CLEARANCE, DEFAULT_UNFOLDED_CAMERA_CLEARANCE } from "./placement";

/** The folded display's camera gap. The key predates the unfolded one, so it keeps its name. */
export const CAMERA_CLEARANCE_SETTING = "cameraClearance";
export const UNFOLDED_CAMERA_CLEARANCE_SETTING = "cameraClearanceUnfolded";

export const CLEARANCE_SETTINGS: Record<Display, string> = {
  folded: CAMERA_CLEARANCE_SETTING,
  unfolded: UNFOLDED_CAMERA_CLEARANCE_SETTING,
};

export const DEFAULT_CLEARANCES: Record<Display, number> = {
  folded: DEFAULT_CAMERA_CLEARANCE,
  unfolded: DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
};

/** Whether the rail shows the debug numbers above its top button (app/debug.tsx). On until turned off. */
export const DEBUG_SETTING = "showDebugNumbers";
export const DEFAULT_SHOW_DEBUG = true;
