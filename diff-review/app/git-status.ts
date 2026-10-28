/**
 * The one read the tab makes of bb's Git plugin itself: its workspace status, which the plugin
 * re-reads whenever bb sees the workspace change while a client watches it (an edit the user makes, a
 * `git` command outside a thread). The tab reloads when it changes, so a change made outside an
 * agent's turn shows without the reload button.
 *
 * The plugin's contract is internal and unversioned, so this is a client view of the one method: the
 * input bb's `workspaceStatus` takes, any output, and the tag (`status:<environment id>`) bb
 * invalidates. It must not import the SDK root (the app has none at run time); zod's schemas are
 * Standard Schemas.
 */
import type { PluginRpcContract } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

export const GIT_PLUGIN_ID = "bb--git";

export const gitStatusReadContract = {
  workspaceStatus: {
    input: z.object({ environmentId: z.string().min(1) }).strict(),
    output: z.unknown(),
    tags: ({ environmentId }: { environmentId: string }) => [`status:${environmentId}`],
  },
} as const satisfies PluginRpcContract;

/**
 * What of a status answer means the diff may have changed: the checkout, the working tree's files and
 * line counts, and the branch's standing against its base. Anything else (a later bb's new fields, a
 * time stamp) is left out, so it cannot make an unchanged workspace look changed. Null for no answer.
 */
export function statusKey(status: unknown): string | null {
  if (typeof status !== "object" || status === null) return null;
  const row = status as { outcome?: unknown; workspace?: Record<string, unknown> };
  if (row.outcome !== "available" || row.workspace === undefined) return JSON.stringify(row.outcome ?? null);
  const { checkout, workingTree, mergeBase } = row.workspace as {
    checkout?: { kind?: unknown; headSha?: unknown };
    workingTree?: { files?: unknown; insertions?: unknown; deletions?: unknown };
    mergeBase?: { baseRef?: unknown; aheadCount?: unknown; behindCount?: unknown } | null;
  };
  return JSON.stringify([
    checkout?.kind ?? null,
    checkout?.headSha ?? null,
    workingTree?.files ?? null,
    workingTree?.insertions ?? null,
    workingTree?.deletions ?? null,
    mergeBase?.baseRef ?? null,
    mergeBase?.aheadCount ?? null,
    mergeBase?.behindCount ?? null,
  ]);
}
