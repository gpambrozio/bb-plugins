// Setting keys, shared by the server (which defines them) and the app (which reads them). No SDK import.
import type { Display } from "./layout";
import { DEFAULT_CAMERA_CLEARANCE, DEFAULT_UNFOLDED_CAMERA_CLEARANCE } from "./placement";

/** The folded display's camera gap. The key predates the unfolded one, so it keeps its name. */
export const CAMERA_CLEARANCE_SETTING = "cameraClearance";
export const UNFOLDED_CAMERA_CLEARANCE_SETTING = "cameraClearanceUnfolded";
/** The button layout, as JSON (shared/layout.ts). */
export const LAYOUT_SETTING = "layout";

export const CLEARANCE_SETTINGS: Record<Display, string> = {
  folded: CAMERA_CLEARANCE_SETTING,
  unfolded: UNFOLDED_CAMERA_CLEARANCE_SETTING,
};

export const DEFAULT_CLEARANCES: Record<Display, number> = {
  folded: DEFAULT_CAMERA_CLEARANCE,
  unfolded: DEFAULT_UNFOLDED_CAMERA_CLEARANCE,
};
