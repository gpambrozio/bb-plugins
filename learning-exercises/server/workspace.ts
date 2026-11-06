/**
 * A thread's workspace as the app needs it to link file references (`Workspace`): the environment and
 * its absolute folder. Null when the thread is gone, has no environment, or its environment has no path
 * any more (an archived thread's is destroyed); the app then shows references as plain text.
 */
import type { Workspace } from "../shared/types";
import type { Ports, ThreadInfo } from "./ports";

export async function workspaceOf(ports: Pick<Ports, "thread" | "environmentPath">, thread: string | ThreadInfo | null): Promise<Workspace | null> {
  const info = typeof thread === "string" ? await ports.thread(thread) : thread;
  if (info === null || info.environmentId === null) return null;
  const rootPath = await ports.environmentPath(info.environmentId);
  if (rootPath === null || !rootPath.startsWith("/")) return null;
  return { threadId: info.id, environmentId: info.environmentId, rootPath };
}
