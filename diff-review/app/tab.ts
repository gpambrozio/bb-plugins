/**
 * The Review tab as bb addresses it: an action tab in each thread's side panel. The header button,
 * the palette commands and the Reviews page open it through bb's panel controller with this
 * reference, and `params: { target }` to start on a view.
 */
import type { ExperimentalPanelController, ExperimentalTabReference } from "@get-bb/plugin-sdk/app";

import type { TargetRequest } from "../shared/types";

export const REVIEW_TAB = { id: "review", context: { kind: "thread" }, availability: "action" } as const satisfies ExperimentalTabReference;

/** Opens (or focuses) the Review tab of the panel's thread, on `target` when given. */
export function openReviewTab(panel: ExperimentalPanelController, target?: TargetRequest): boolean {
  return panel.openTab({ tab: REVIEW_TAB, ...(target === undefined ? {} : { params: { target } }) });
}
