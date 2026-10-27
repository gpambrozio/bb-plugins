import { type ExperimentalThreadActionTabProps, type PluginAppSlots, useBbNavigate } from "@get-bb/plugin-sdk/app";

import { SkillBrowser, selectionFrom } from "./browser";
import { SKILLS_ICON } from "./icons";
import { useSkillList } from "./use-skills";

/** The Skills tab's id; the composer button and the command open it by this. */
export const PANEL_ACTION_ID = "skills";

/**
 * The Skills tab in a thread's side panel. **Add to chat** puts the command in
 * the thread's message box, so after it the panel hands the screen to the
 * thread — which on a narrow window is what brings the conversation, and its
 * composer, back over the panel.
 */
export function SkillsPanel({ threadId, params }: ExperimentalThreadActionTabProps) {
  const { state } = useSkillList(threadId);
  const navigate = useBbNavigate();
  // `params` names the skill the popover had open, if any; the tab opens on it.
  // The composer takes focus after Add to chat, with the command in it.
  return (
    <SkillBrowser
      threadId={threadId}
      frame="panel"
      list={state}
      initialSelection={selectionFrom(params)}
      onAdded={() => navigate.toThread(threadId)}
    />
  );
}

/**
 * The Skills tab: an action tab in the thread's side panel on bb 0.47, which
 * replaced `threadPanelAction` with `experimental_tab`. bb 0.45 and 0.46 have
 * no `experimental_tab`, and their `threadPanelAction` takes the same fields,
 * so the plugin keeps running there. Both open by the same id.
 */
export function registerSkillsTab(slots: PluginAppSlots) {
  const tab = { id: PANEL_ACTION_ID, title: "Skills", icon: SKILLS_ICON, layout: "padded", component: SkillsPanel } as const;
  if (typeof slots.experimental_tab === "function") {
    slots.experimental_tab({ ...tab, context: { kind: "thread" }, availability: "action" });
  } else {
    (slots as unknown as LegacySlots).threadPanelAction(tab);
  }
}

/** bb 0.45–0.46's thread panel slot, gone from the SDK's types since 0.6.73. */
interface LegacySlots {
  threadPanelAction(registration: {
    id: string;
    title: string;
    icon: string;
    layout: "padded";
    component: typeof SkillsPanel;
  }): void;
}
