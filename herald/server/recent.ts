/**
 * The Herald page's history: the newest sentences of every thread, each with
 * the names bb has for its thread and project now. The names are looked up
 * when the page reads, not stored with the sentence, so a renamed thread
 * shows its new title. A lookup that fails costs the row its names, never
 * its place: a thread bb no longer knows stays listed, with nothing to open.
 */
import type { RecentHistoryItem } from "../shared/herald";
import type { ThreadHistoryItem } from "./history";
import type { Log, NamesPort } from "./ports";

interface Names {
  threadTitle: string | null;
  projectName: string | null;
  threadExists: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withNames(items: readonly ThreadHistoryItem[], names: NamesPort, log: Log): Promise<RecentHistoryItem[]> {
  async function namesOf(threadId: string): Promise<Names> {
    let thread: Awaited<ReturnType<NamesPort["thread"]>>;
    try {
      thread = await names.thread(threadId);
    } catch (error) {
      log.warn(`Could not read thread ${threadId}: ${reasonOf(error)}`);
      return { threadTitle: null, projectName: null, threadExists: true };
    }
    if (thread === null) return { threadTitle: null, projectName: null, threadExists: false };
    const projectName = await names.projectName(thread.projectId).catch((error: unknown) => {
      log.warn(`Could not read project ${thread.projectId}: ${reasonOf(error)}`);
      return null;
    });
    return { threadTitle: thread.title, projectName, threadExists: true };
  }

  // One lookup per thread, however many of its sentences are listed.
  const lookups = new Map<string, Promise<Names>>();
  function lookup(threadId: string): Promise<Names> {
    let found = lookups.get(threadId);
    if (found === undefined) {
      found = namesOf(threadId);
      lookups.set(threadId, found);
    }
    return found;
  }
  return Promise.all(items.map(async (item) => ({ ...item, ...(await lookup(item.threadId)) })));
}
