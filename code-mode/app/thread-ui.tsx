// What a Code Mode thread shows: a "Code" badge on its row in the thread list (when the list draws
// metadata lines: Organize → Rows → Metadata), and a read-only "Code Mode: on" line in its thread menu.
import {
  experimental_Icon as Icon,
  experimental_THREAD_ACTION_GROUPS,
  type ExperimentalThreadRowMetadataRegistration,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";

import { CLAUDE_CODE, CODE_MODE_ICON } from "./send-menu";
import { useThreadStates, type ThreadStates } from "./thread-states";

export const FIXED_TEXT = "Fixed for this thread";

export const rowBadge: ExperimentalThreadRowMetadataRegistration<ThreadStates> = {
  id: "code-mode",
  useData: ({ threads }) => useThreadStates(threads.filter((thread) => thread.providerId === CLAUDE_CODE).map((thread) => thread.id)),
  component: ({ thread, data }) =>
    data[thread.id] === "on" ? (
      <span className="inline-flex items-center gap-0.5 text-muted-foreground" title={`Code Mode. ${FIXED_TEXT}.`}>
        <Icon name={CODE_MODE_ICON} className="size-3" aria-hidden />
        <span>Code</span>
      </span>
    ) : null,
};

export const menuLine: PluginThreadActionRegistration<ThreadStates> = {
  id: "code-mode",
  title: "Code Mode",
  icon: CODE_MODE_ICON,
  group: experimental_THREAD_ACTION_GROUPS.state,
  useData: ({ threadIds }) => useThreadStates(threadIds),
  item: ({ thread, data }) =>
    data?.[thread.id] === "on"
      ? {
          label: "Code Mode: on",
          detail: FIXED_TEXT,
          icon: CODE_MODE_ICON,
          disabled: true,
          run: () => undefined,
        }
      : null,
};
