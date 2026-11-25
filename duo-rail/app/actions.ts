// What a button or a menu item does when it is pressed, for every action that needs no component of
// its own. A menu, the recent threads and bb's thread-menu actions are components (rail.tsx), because
// they read live state through hooks.
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { joinArgs, type LeafAction } from "../shared/layout";
import { summarize, type BbCommandResult } from "./bb-command";

export interface ActionDeps {
  navigate: Pick<BbNavigate, "toThread" | "toProject" | "toCompose" | "openUrl">;
  history: Pick<History, "back" | "forward">;
  reload(): void;
  runBbCommand(args: readonly string[]): Promise<BbCommandResult>;
  notify: Pick<typeof toast, "success" | "error" | "message">;
}

export type DirectAction = Exclude<LeafAction, { kind: "recentThreads" } | { kind: "threadAction" }>;

export function isDirect(action: LeafAction): action is DirectAction {
  return action.kind !== "recentThreads" && action.kind !== "threadAction";
}

/** One notice per run: "Running…" first, then the result in its place. */
let runs = 0;
const runToastId = () => `duo-rail-command-${Date.now()}-${(runs += 1)}`;

/** Says how a `bb` command went, in bb's own toast stack, in place of the notice `id` names. */
export function reportBbCommand(notify: ActionDeps["notify"], args: readonly string[], result: BbCommandResult, id?: string): void {
  const title = `bb ${joinArgs(args)}`;
  const output = "output" in result ? summarize(result.output) : "";
  switch (result.outcome) {
    case "unavailable":
      notify.error(`Could not run ${title}`, { id, description: result.reason });
      return;
    case "timed-out":
      notify.error(`${title} was still running after a minute, so it was stopped`, { id, description: output || undefined });
      return;
    case "cancelled":
      notify.message(`${title} was stopped`, { id, description: "The page closed or Duo Rail reloaded before it finished." });
      return;
    case "finished":
      if (result.exitCode === 0) notify.success(title, { id, description: output || "Done." });
      else notify.error(`${title} failed (exit status ${result.exitCode})`, { id, description: output || undefined });
  }
}

export function runAction(action: DirectAction, deps: ActionDeps): void {
  switch (action.kind) {
    case "back":
      deps.history.back();
      return;
    case "forward":
      deps.history.forward();
      return;
    case "reload":
      deps.reload();
      return;
    case "newThread":
      deps.navigate.toCompose(action.projectId === null ? undefined : { projectId: action.projectId });
      return;
    case "openThread":
      deps.navigate.toThread(action.threadId);
      return;
    case "openProject":
      deps.navigate.toProject(action.projectId);
      return;
    case "openUrl":
      if (!deps.navigate.openUrl(action.url)) deps.notify.error("bb would not open that address", { description: action.url });
      return;
    case "bbCommand": {
      const id = runToastId();
      deps.notify.message(`Running bb ${joinArgs(action.args)}…`, { id });
      void deps.runBbCommand(action.args).then(
        (result) => reportBbCommand(deps.notify, action.args, result, id),
        (error: unknown) => deps.notify.error(`Could not run bb ${joinArgs(action.args)}`, { id, description: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
  }
}
