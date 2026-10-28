/**
 * The two things the Review tab changes in a workspace, both on the user's click: applying a comment's
 * suggested change, and reverting an uncommitted file or some of its hunks. Each reads the file through
 * bb on whichever machine holds the workspace, checks it still reads as the view showed it, and writes
 * it back only if nobody wrote it meanwhile (`expectedSha256`). Nothing here runs git; a revert needs
 * only the file's patch and its `HEAD` version, which bb reads at a revision.
 */
import { posix } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { revertHunks } from "../shared/revert";
import { bodyParts, replaceLines } from "../shared/suggestion";
import type { ReviewThread } from "../shared/types";
import { workspaceOf } from "./diff";
import type { GitReads } from "./git";
import { ReviewError, targetFromKey } from "./review";
import type { ReviewStore } from "./store";

type Sdk = BbPluginApi["sdk"];

export interface SuggestionInput {
  /** The bb thread whose tab asks. */
  threadId: string;
  reviewThreadId: string;
  commentId: string;
  /** Where the thread's lines are now, as the tab placed them, and what they read there. */
  startLine: number;
  endLine: number;
  expected: string;
  code: string;
}

export interface RevertInput {
  threadId: string;
  path: string;
  /** The file's revision as the tab showed it; a newer one is refused. */
  revision: string;
  /** Indexes of the hunks to revert, in the patch's order, or null for the whole file. */
  hunks: number[] | null;
}

function text(file: { content: string; contentEncoding?: string }): string {
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}

export class WorkspaceEdits {
  constructor(
    private readonly sdk: Sdk,
    private readonly store: ReviewStore,
    private readonly git: GitReads,
    /** Tells the workspace's tabs to reload, and the comment thread's that it changed. */
    private readonly changed: (environmentId: string, sessionId: string | null) => void,
  ) {}

  async applySuggestion(input: SuggestionInput): Promise<ReviewThread> {
    const thread = this.store.thread(input.reviewThreadId);
    if (thread === null) throw new ReviewError(`No comment thread ${input.reviewThreadId}.`, "unknown_thread");
    const session = this.store.sessionById(thread.sessionId)!;
    const target = targetFromKey(session.targetKey);
    if (target.kind !== "uncommitted" && target.kind !== "all" && target.kind !== "unstaged") {
      throw new ReviewError("A suggestion applies to the working copy; open the uncommitted, unstaged or all-changes view to apply it.", "not_working_copy");
    }
    if (thread.side !== "new" || thread.startLine === 0) throw new ReviewError("Only a suggestion on new lines can be applied.", "invalid_place");
    const comment = thread.comments.find((row) => row.id === input.commentId);
    const offered = comment === undefined ? [] : bodyParts(comment.body).flatMap((part) => (part.kind === "suggestion" ? [part.code] : []));
    if (!offered.includes(input.code)) throw new ReviewError("That comment does not suggest this change.", "invalid_suggestion");
    const environment = await workspaceOf(this.sdk, input.threadId);
    if (environment.id !== session.environmentId || environment.path === null) {
      throw new ReviewError("That comment belongs to another workspace's review.", "wrong_workspace");
    }
    const path = posix.join(environment.path, thread.filePath);
    const file = await this.sdk.files.read({ hostId: environment.hostId, path });
    const next = replaceLines(text(file), input.startLine, input.endLine, input.expected, input.code);
    if (next === null) throw new ReviewError(`Lines ${input.startLine}-${input.endLine} of ${thread.filePath} changed since the diff was loaded; reload and try again.`, "changed");
    await this.write(environment.hostId, path, next, file.sha256);
    this.store.setStatus(thread.id, "resolved", false);
    this.changed(environment.id, session.id);
    return this.store.thread(thread.id)!;
  }

  async revert(input: RevertInput): Promise<void> {
    const environment = await workspaceOf(this.sdk, input.threadId);
    if (environment.path === null) throw new ReviewError("This workspace has no checkout.", "diff_unavailable");
    const files = await this.git.files(environment.id, { type: "uncommitted" }, false);
    if (files.outcome !== "available") throw new ReviewError("bb could not list the workspace's changes.", "diff_unavailable");
    const entry = files.files.find((row) => row.path === input.path);
    if (entry === undefined) throw new ReviewError(`${input.path} has no uncommitted change now.`, "changed");
    if (entry.revision !== input.revision) throw new ReviewError(`${input.path} changed since the diff was loaded; reload and try again.`, "changed");
    const path = posix.join(environment.path, entry.path);
    if (input.hunks !== null) {
      if (entry.binary) throw new ReviewError("A binary file has no hunks; revert the whole file.", "invalid_place");
      const shipped = files.initialPatches.find((patch) => patch.path === entry.path)?.patch;
      const patch = shipped ?? (await this.git.patches(environment.id, { type: "uncommitted" }, false, [entry])).patches[0]?.patch;
      if (patch === undefined) throw new ReviewError(`bb gave no diff for ${entry.path}.`, "diff_unavailable");
      const file = await this.sdk.files.read({ hostId: environment.hostId, path });
      const next = revertHunks(text(file), patch, input.hunks);
      if (next === null) throw new ReviewError(`${entry.path} changed since the diff was loaded; reload and try again.`, "changed");
      await this.write(environment.hostId, path, next, file.sha256);
    } else if (entry.changeKind === "added") {
      await this.sdk.files.remove({ hostId: environment.hostId, path });
    } else if (entry.changeKind === "modified" || entry.changeKind === "deleted" || entry.changeKind === "type_changed") {
      const committed = await this.sdk.files.read({ hostId: environment.hostId, rootPath: environment.path, path, ref: "HEAD" });
      const current = entry.changeKind === "deleted" ? null : await this.sdk.files.read({ hostId: environment.hostId, path });
      await this.sdk.files.write({
        hostId: environment.hostId,
        path,
        content: committed.content,
        contentEncoding: committed.contentEncoding === "base64" ? "base64" : "utf8",
        createParents: true,
        expectedSha256: current === null ? null : current.sha256,
      });
    } else {
      throw new ReviewError(`A ${entry.changeKind} file cannot be reverted here; use bb's diff panel or git.`, "invalid_place");
    }
    this.changed(environment.id, null);
  }

  private async write(hostId: string, path: string, content: string, expectedSha256: string): Promise<void> {
    try {
      await this.sdk.files.write({ hostId, path, content, contentEncoding: "utf8", expectedSha256 });
    } catch (error) {
      throw new ReviewError(`Could not write ${posix.basename(path)}: ${error instanceof Error ? error.message : String(error)}`, "changed");
    }
  }
}
