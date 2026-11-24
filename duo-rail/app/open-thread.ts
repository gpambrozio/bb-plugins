// The open thread, as bb's thread-menu actions want it. Pure, over the SDK's sidebar view.
import type { PluginSidebarThread, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

export type OpenThreadSource = Pick<
  PluginSidebarThread,
  "id" | "projectId" | "parentThreadId" | "parentNotifications" | "archivedAt" | "pinnedAt" | "sectionId" | "isUnread" | "status" | "environment"
>;

/** The thread in view as a thread action's target, or null when no thread is open or bb's list lacks it. */
export function openThreadTarget(threads: readonly OpenThreadSource[], threadId: string | null): PluginThreadActionTarget | null {
  if (threadId === null) return null;
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: thread.environment?.id == null ? null : { id: thread.environment.id, path: thread.environment.path },
  };
}
