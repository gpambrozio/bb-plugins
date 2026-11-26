/**
 * Whether the tabs' agent chats show in bb's sidebar. They start hidden
 * (`visibility: "hidden"`) unless the owner's setting says to show them; the
 * panel's "open in bb" makes one visible for good. bb sends no push
 * notifications for a hidden thread and leaves it out of @-mentions and
 * thread lists, which is the trade-off the setting offers back.
 *
 * Every agent chat is a thread this plugin spawned, so bb stamps it with the
 * plugin's id (`originPluginId`); that is how the ones started before this
 * existed are found.
 */
export type Visibility = "visible" | "hidden";

export interface ChatVisibilityPorts {
  /** One page of the plugin's own live threads, hidden ones included. */
  list(offset: number, limit: number): Promise<{ id: string; visibility: string }[]>;
  update(threadId: string, visibility: Visibility): Promise<void>;
  warn(message: string): void;
}

const PAGE = 100;

/** Sets every live agent chat to `visibility`; returns how many changed. One that fails is logged and skipped. */
export async function setAllChats(ports: ChatVisibilityPorts, visibility: Visibility, signal?: AbortSignal): Promise<number> {
  const wrong: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (signal?.aborted) return 0;
    const page = await ports.list(offset, PAGE);
    for (const thread of page) if (thread.visibility !== visibility) wrong.push(thread.id);
    if (page.length < PAGE) break;
  }
  let changed = 0;
  for (const threadId of wrong) {
    if (signal?.aborted) break;
    try {
      await ports.update(threadId, visibility);
      changed += 1;
    } catch (error) {
      ports.warn(`could not make agent chat ${threadId} ${visibility}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return changed;
}

/**
 * Once per plugin load: with the setting on, every agent chat is shown; with
 * it off, the chats that existed before chats started hidden are hidden once
 * (`migrated` records that), and a chat the owner opened since stays shown.
 */
export async function settleChats(
  ports: ChatVisibilityPorts,
  options: { alwaysShow: boolean; migrated: () => Promise<boolean>; markMigrated: () => Promise<void> },
  signal?: AbortSignal,
): Promise<void> {
  if (options.alwaysShow) {
    await setAllChats(ports, "visible", signal);
    return;
  }
  if (await options.migrated()) return;
  await setAllChats(ports, "hidden", signal);
  if (!signal?.aborted) await options.markMigrated();
}
