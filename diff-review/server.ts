// diff-review — the server entry.
//
// The Review tab's data (diffs from bb's environment APIs, threads and comments in the plugin's own
// SQLite), "Send to agent" into the thread under review, and `bb diff-review`, which that thread's
// agent answers each comment thread with. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { diffReviewCli } from "./server/cli";
import { ReviewService } from "./server/review";
import { MIGRATIONS, ReviewStore } from "./server/store";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    ignorePatterns: {
      type: "string",
      label: "Files to leave out of reviews",
      description:
        "Generated files, lockfiles and the like, one gitignore pattern per line (for example `*.lock` or `dist/`).",
      experimental_multiline: true,
      default: "",
    },
    readIgnoreFiles: {
      type: "boolean",
      label: "Read the workspace's .diffityignore",
      description: "Also leave out what `.diffityignore` and `.git/info/diffityignore` in the workspace list, as diffity does.",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new ReviewStore(db);
  const service = new ReviewService(bb, store, () => settings.get());

  bb.rpc.register(rpcContract, {
    getReview: ({ threadId, target }) => service.view(threadId, target),
    loadPatches: async ({ threadId, target, paths }) => ({ patches: await service.patches(threadId, target, paths) }),
    listThreads: ({ sessionId }) => ({ threads: service.threads(sessionId) }),
    createThread: (input) => ({ thread: service.createThread(input) }),
    addComment: ({ reviewThreadId, body }) => ({ thread: service.addUserComment(reviewThreadId, body) }),
    editComment: ({ commentId, body }) => ({ thread: service.editComment(commentId, body) }),
    deleteComment: ({ commentId }) => {
      service.deleteComment(commentId);
      return { ok: true as const };
    },
    setStatus: ({ reviewThreadId, status }) => ({ thread: service.setStatus(reviewThreadId, status) }),
    send: (input) => service.send(input),
  });

  bb.cli.register(diffReviewCli(service));

  // A turn that ends, well or badly, closes out what was sent to that thread and tells open tabs on
  // its workspace that the files may have changed.
  const turnEnded = async ({ thread }: { thread: { id: string; environmentId: string | null } }) => {
    try {
      await service.turnEnded(thread);
    } catch (error) {
      bb.log.warn(`Could not close out the review sends to ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  bb.events.on("thread.idle", turnEnded);
  bb.events.on("thread.failed", turnEnded);
}
