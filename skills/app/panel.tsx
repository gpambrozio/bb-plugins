import { type PluginThreadPanelProps, useBbNavigate } from "@get-bb/plugin-sdk/app";

import { SkillBrowser } from "./browser";
import { useSkillList } from "./use-skills";

/** The `threadPanelAction` id; the composer button and the command open it by this. */
export const PANEL_ACTION_ID = "skills";

/**
 * The Skills tab in a thread's side panel. **Add to chat** puts the command in
 * the thread's message box, so after it the panel hands the screen to the
 * thread — which on a narrow window is what brings the conversation, and its
 * composer, back over the panel.
 */
export function SkillsPanel({ threadId }: PluginThreadPanelProps) {
  const { state } = useSkillList(threadId);
  const navigate = useBbNavigate();
  // The composer then takes focus, with the command in it.
  return <SkillBrowser threadId={threadId} frame="panel" list={state} onAdded={() => navigate.toThread(threadId)} />;
}
