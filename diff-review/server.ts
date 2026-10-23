// diff-review — the server entry.
//
// The Review tab's data (diffs from bb's environment APIs, threads and comments in the plugin's own
// SQLite), "Send to agent" into the thread under review, AI runs in threads of their own (reviews,
// @-mentions, fixes in a new thread), and `bb diff-review` and the `diff_review_*` tools, which agents
// answer each comment thread with. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { diffReviewCli } from "./server/cli";
import { ReviewService } from "./server/review";
import { RunService } from "./server/runs";
import { RUN_METADATA_KEY, TOOL_NAMES } from "./server/tool-names";
import { registerTools } from "./server/tools";
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
    aiProvider: {
      type: "string",
      label: "Provider for AI runs",
      description:
        "The provider AI reviews and fixes in a new thread start with (each run can pick another): `claude-code`, `codex`, `opencode`, … A mention of @claude, @codex or @opencode always runs that agent.",
      default: "claude-code",
    },
    aiModel: {
      type: "string",
      label: "Model for AI runs",
      description: "The model for that provider, as `bb provider models` lists it. Leave blank for the provider's default.",
      default: "",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new ReviewStore(db);
  const service = new ReviewService(bb, store, () => settings.get());
  const runs = new RunService(bb, store, service, () => settings.get());
  service.onUserComment = (thread, body) => runs.onUserComment(thread, body);

  bb.rpc.register(rpcContract, {
    getReview: ({ threadId, target, autoTarget }) => service.view(threadId, target, autoTarget === true),
    loadPatches: async ({ threadId, target, paths }) => ({ patches: await service.patches(threadId, target, paths) }),
    listThreads: ({ sessionId }) => service.sessionState(sessionId),
    createThread: (input) => ({ thread: service.createThread(input) }),
    addComment: ({ reviewThreadId, body }) => ({ thread: service.addUserComment(reviewThreadId, body) }),
    editComment: ({ commentId, body }) => ({ thread: service.editComment(commentId, body) }),
    deleteComment: ({ commentId }) => {
      service.deleteComment(commentId);
      return { ok: true as const };
    },
    setStatus: ({ reviewThreadId, status }) => ({ thread: service.setStatus(reviewThreadId, status) }),
    send: (input) => service.send(input),
    runDefaults: ({ threadId }) => runs.defaults(threadId),
    startReview: async (input) => ({ run: await runs.startReview(input) }),
    fixInNewThread: (input) => runs.fixInNewThread(input),
    closeRun: async ({ runId }) => {
      await runs.close(runId);
      return { ok: true as const };
    },
  });

  bb.cli.register(diffReviewCli(service, runs));

  // The `diff_review_*` tools go only to the threads AI runs start; every thread keeps the skill.
  registerTools(bb, service, runs);
  bb.agents.configure((context) => {
    const runId = context.pluginMetadata[RUN_METADATA_KEY];
    const isRun = typeof runId === "string" && /^[0-9a-f]{12}$/.test(runId);
    return { tools: isRun ? TOOL_NAMES : [], skills: ["diff-review"] };
  });

  // A turn that ends, well or badly, closes out what was sent to that thread and tells open tabs on
  // its workspace that the files may have changed.
  const turnEnded = async (thread: { id: string; environmentId: string | null }, lastText: string | null, failed: boolean) => {
    try {
      await service.turnEnded(thread);
      await runs.turnEnded(thread.id, lastText, failed);
    } catch (error) {
      bb.log.warn(`Could not close out the review sends and runs of ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => turnEnded(thread, lastAssistantText, false));
  bb.events.on("thread.failed", ({ thread, error }) => turnEnded(thread, error, true));
}
