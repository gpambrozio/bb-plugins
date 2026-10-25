/**
 * The `diff_review_*` agent tools, for the threads AI runs start. `bb.agents.configure` offers them only
 * to a thread whose plugin metadata names a run (`server.ts`); every call is then checked against the
 * store by the calling thread's id, which bb supplies, so a thread that set that metadata itself gains
 * nothing it could not already do with `bb diff-review`. Refusals come back as tool errors the agent
 * can act on.
 */
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { BODY_MAX_CHARS, GENERAL_PATH, describeLocation, severitySchema, sideSchema } from "../shared/types";
import { formatThread } from "./cli";
import { ReviewError, type AgentAction, type ReviewService } from "./review";
import type { RunService } from "./runs";
import { TOOL } from "./tool-names";

const id = z.string().min(4).max(64).describe("The comment thread's id, or a unique prefix of it");
const text = z.string().min(1).max(BODY_MAX_CHARS);

async function guarded(work: () => Promise<string>): Promise<PluginAgentToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReviewError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
}

export function registerTools(bb: BbPluginApi, review: ReviewService, runs: RunService): void {
  // A run's thread can call in before bb has told the plugin which thread it is: bind it first.
  const forCaller = (threadId: string, work: () => Promise<string>) =>
    guarded(async () => {
      await runs.bindIfPending(threadId);
      return work();
    });

  bb.agents.registerTool({
    name: TOOL.threads,
    description: "List the Diff Review comment threads you may answer (for an AI review, every thread of the review), with every comment.",
    presentation: { label: { pending: "Reading review threads", completed: "Read review threads" } },
    parameters: z.object({ includeClosed: z.boolean().optional().describe("Include resolved and dismissed threads") }),
    execute: (args, ctx) =>
      forCaller(ctx.threadId, async () => {
        const threads = review.sentTo(ctx.threadId, args.includeClosed === true);
        return threads.length === 0 ? "No open review threads for this thread." : threads.map(formatThread).join("\n\n");
      }),
  });

  bb.agents.registerTool({
    name: TOOL.comment,
    description:
      "Leave a review comment on lines of a file in the diff under review (AI review runs only). Lines are counted on the side given: `new` for added or kept code, `old` for removed code. startLine 0 comments on the whole file.",
    presentation: { label: { pending: "Adding a review comment", completed: "Added a review comment" } },
    parameters: z.object({
      file: z.string().min(1).max(4096).describe("The file's path in the diff"),
      startLine: z.number().int().min(0),
      endLine: z.number().int().min(0).optional().describe("Defaults to startLine"),
      side: sideSchema.optional().describe("`new` (default) or `old`"),
      severity: severitySchema.optional(),
      body: text.describe("Markdown"),
    }),
    execute: (args, ctx) =>
      forCaller(ctx.threadId, async () => {
        const thread = await runs.addComment(ctx.threadId, {
          filePath: args.file,
          side: args.startLine === 0 ? null : (args.side ?? "new"),
          startLine: args.startLine,
          endLine: args.endLine ?? args.startLine,
          severity: args.severity ?? null,
          body: args.body,
        });
        return `Added ${thread.id} on ${describeLocation(thread)}.`;
      }),
  });

  bb.agents.registerTool({
    name: TOOL.generalComment,
    description: "Leave a review comment about the whole diff (AI review runs only).",
    presentation: { label: { pending: "Adding a review summary", completed: "Added a review summary" } },
    parameters: z.object({ body: text.describe("Markdown") }),
    execute: (args, ctx) =>
      forCaller(ctx.threadId, async () => {
        const thread = await runs.addComment(ctx.threadId, { filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, severity: null, body: args.body });
        return `Added ${thread.id} on the whole diff.`;
      }),
  });

  const answers: { name: string; action: AgentAction; description: string; what: string; pending: string; completed: string; done: string }[] = [
    { name: TOOL.reply, action: "reply", description: "Answer in a Diff Review comment thread; it stays open.", what: "Your reply, in Markdown", pending: "Replying in a review thread", completed: "Replied in a review thread", done: "Replied on" },
    { name: TOOL.resolve, action: "resolve", description: "Resolve a Diff Review comment thread with a one-line summary of what you changed.", what: "What you changed, in one sentence", pending: "Resolving a review thread", completed: "Resolved a review thread", done: "Resolved" },
    { name: TOOL.dismiss, action: "dismiss", description: "Close a Diff Review comment thread you will not act on, with the reason.", what: "Why it needs no change", pending: "Dismissing a review thread", completed: "Dismissed a review thread", done: "Dismissed" },
  ];
  for (const tool of answers) {
    bb.agents.registerTool({
      name: tool.name,
      description: tool.description,
      presentation: { label: { pending: tool.pending, completed: tool.completed } },
      parameters: z.object({ threadId: id, text: text.describe(tool.what) }),
      execute: (args, ctx) =>
        forCaller(ctx.threadId, async () => {
          const thread = await review.answer(ctx.threadId, args.threadId, tool.action, args.text);
          return `${tool.done} ${thread.id} (${describeLocation(thread)}).`;
        }),
    });
  }
}
