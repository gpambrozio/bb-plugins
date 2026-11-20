// project-actions — the app entry.
//
// A button in each thread's header with a menu of the project's actions (`.bb/actions.json` in the
// thread's workspace); picking one runs it in a terminal of the thread, in bb's terminal panel.
// See AGENTS.md.
import { definePluginApp, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

import { ActionsHeaderButton, BUTTON_LABEL, type HeaderActionProps } from "./app/actions-menu";
import { ActionsTab } from "./app/actions-panel";
import { EditorTab } from "./app/editor";
import { EDITOR_TAB, LIST_TAB } from "./app/tabs";

type LegacySlots = { experimental_threadHeaderAction?: (registration: { id: string; title: string; component: ComponentType<HeaderActionProps> }) => void };

/**
 * The button and its menu need a component of the plugin's own in the header, which only the
 * older header slot draws: `experimental_threadHeaderAction`, untyped since SDK 0.6.92 and still
 * drawn by bb 0.49 and 0.50. A `placement: "header"` thread action is a plain button (no menu)
 * that bb merges with every other plugin's into one split button, so it is only the fallback for a
 * bb that drops the old slot: it opens a tab beside the thread with the same actions.
 */
export function registerActions(app: PluginAppBuilder): "menu" | "tab" {
  // The editor, opened from the menu (or the fallback list) beside the thread.
  app.slots.experimental_tab({ ...EDITOR_TAB, title: "Edit actions", icon: "EditFile", tooltip: "Edit this project's actions", component: EditorTab });
  const legacy = (app.slots as unknown as LegacySlots).experimental_threadHeaderAction;
  if (typeof legacy === "function") {
    legacy.call(app.slots, { id: "actions", title: BUTTON_LABEL, component: ActionsHeaderButton });
    return "menu";
  }
  app.slots.experimental_tab({ ...LIST_TAB, title: "Actions", icon: "Play", tooltip: BUTTON_LABEL, component: ActionsTab });
  app.slots.experimental_threadAction({
    id: "actions",
    title: "Actions",
    icon: "Play",
    group: "project-actions",
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Actions",
      detail: BUTTON_LABEL,
      icon: "Play",
      run: () => {
        experimental_panel.openTab({ tab: LIST_TAB });
      },
    }),
  });
  return "tab";
}

export default definePluginApp((app) => {
  registerActions(app);
});
