import { type PluginThreadPanelProps, useBbNavigate } from "@get-bb/plugin-sdk/app";

import { SkillBrowser } from "./browser";
import { useSkillList } from "./use-skills";

/** The `threadPanelAction` id; the composer button and the command open it by this. */
export const PANEL_ACTION_ID = "skills";

/**
 * The Skills tab in a thread's side panel. Invoking sends a message to the
 * thread, so the thread is where the result appears: after a send — or after
 * **Insert in chat** — the panel hands the screen to it, which on a narrow
 * window is what brings the conversation back over the panel.
 */
export function SkillsPanel({ threadId }: PluginThreadPanelProps) {
  const { state } = useSkillList(threadId);
  const navigate = useBbNavigate();
  // Both hand the screen to the thread; after an insert the composer then
  // takes focus, with the command in it.
  const toThread = () => navigate.toThread(threadId);
  return <SkillBrowser threadId={threadId} frame="panel" list={state} onInvoked={toThread} onInserted={toThread} />;
}
