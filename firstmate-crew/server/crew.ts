/**
 * What the captain can do to one crewmate from the board: steer it, interrupt its turn, end it, note
 * something on it, or have the first mate relaunch it.
 *
 * Every action first checks the thread is a child of the stored first mate, so the board cannot be
 * pointed at an arbitrary thread. Ending a crewmate archives its thread, and bb retires its worktree
 * after its grace period, so only committed work can be restored: that is why End asks first unless the
 * task is in the backlog's Done. Relaunching is the first mate's job, because it owns the brief and the
 * backlog.
 *
 * Steering goes straight to the crewmate, as if typed into its own thread. The first mate hears when
 * that turn ends, because bb notifies a parent of its child's turns however they were started.
 */
import { CREW_METADATA, type BacklogItem } from "../shared/types";
import { metadataText } from "./fleet";
import { readBacklog } from "./home";
import { activeHome, askMate, resolveMate, type MateDeps } from "./mate";
import type { ThreadInfo } from "./ports";
import { TEMPLATES, message } from "./templates";

/** The thread, once it is known to be a live child of the first mate. */
async function requireCrew(deps: MateDeps, threadId: string): Promise<ThreadInfo> {
  const [thread, mate] = await Promise.all([deps.threads.get(threadId), resolveMate(deps)]);
  if (thread === null || mate === null || thread.parentThreadId !== mate.id) {
    throw new Error(`${threadId} is not in the first mate's crew.`);
  }
  return thread;
}

export async function steerCrew(deps: MateDeps, threadId: string, text: string): Promise<void> {
  await requireCrew(deps, threadId);
  await deps.threads.send(threadId, text, "steer");
}

export async function interruptCrew(deps: MateDeps, threadId: string): Promise<void> {
  await requireCrew(deps, threadId);
  await deps.threads.stop(threadId);
}

/**
 * The backlog item a crewmate is doing: the one that recorded its thread id, else a live item with
 * its task id, else a Done item with its task id (work that landed while the thread stayed open).
 */
function joinedItem(backlog: readonly BacklogItem[], threadId: string, task: string | null): BacklogItem | null {
  const withTask = backlog.filter((item) => task !== null && item.id === task);
  return (
    backlog.find((item) => item.threadId === threadId) ??
    withTask.find((item) => item.section !== "done") ??
    withTask.find((item) => item.section === "done") ??
    null
  );
}

/**
 * Archives the crewmate when its work is recorded as Done, or when the captain has confirmed;
 * otherwise archives nothing and says the captain must confirm, since ending a crewmate whose task
 * is still open loses the thread the first mate would relaunch or read.
 */
export async function endCrew(
  deps: MateDeps,
  threadId: string,
  confirmed: boolean,
): Promise<{ ended: boolean; needsConfirmation: boolean }> {
  await requireCrew(deps, threadId);
  const [metadata, backlog] = await Promise.all([
    deps.threads.metadata(threadId),
    activeHome(deps).then(readBacklog),
  ]);
  const item = joinedItem(backlog, threadId, metadataText(metadata, CREW_METADATA.task));
  if (item?.section !== "done" && !confirmed) return { ended: false, needsConfirmation: true };
  await deps.threads.archive(threadId);
  return { ended: true, needsConfirmation: false };
}

/** What the first mate is asked when the captain presses Relaunch (`templates/messages/relaunch.md`). */
export async function relaunchCrew(deps: MateDeps, threadId: string, note: string): Promise<void> {
  const thread = await requireCrew(deps, threadId);
  const task = metadataText(await deps.threads.metadata(threadId), CREW_METADATA.task);
  const title = thread.title ?? "";
  await askMate(
    deps,
    await message(TEMPLATES.relaunch, {
      title,
      task: task ?? "",
      threadId,
      environmentId: thread.environmentId ?? "",
      note: note.trim(),
    }),
  );
}

/** Tells the first mate something the captain wants on a crewmate's card (`templates/messages/board-note.md`). */
export async function noteCrew(deps: MateDeps, threadId: string, note: string): Promise<void> {
  const thread = await requireCrew(deps, threadId);
  await askMate(deps, await message(TEMPLATES.boardNote, { title: thread.title ?? "", threadId, note: note.trim() }));
}
