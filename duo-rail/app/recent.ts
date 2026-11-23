// The More menu's thread list: the threads that last wanted attention, as bb's sidebar would show
// them. Pure, over the SDK's sidebar view (`experimental_useSidebarThreads`).

/** The fields of the SDK's `PluginSidebarThread` this list reads. */
export interface RecentThreadSource {
  id: string;
  displayTitle: string;
  isHidden: boolean;
  isArchived: boolean;
  isUnread: boolean;
  hasPendingInteraction: boolean;
  latestAttentionAt: number;
}

export interface RecentThread {
  id: string;
  title: string;
  /** Waiting for an answer, or finished since the user last looked. */
  needsAttention: boolean;
}

export const RECENT_THREAD_LIMIT = 5;

export function recentThreads(threads: readonly RecentThreadSource[], currentThreadId: string | null, limit = RECENT_THREAD_LIMIT): RecentThread[] {
  return threads
    .filter((thread) => !thread.isHidden && !thread.isArchived && thread.id !== currentThreadId)
    .sort((a, b) => b.latestAttentionAt - a.latestAttentionAt)
    .slice(0, limit)
    .map((thread) => ({ id: thread.id, title: thread.displayTitle, needsAttention: thread.hasPendingInteraction || thread.isUnread }));
}
