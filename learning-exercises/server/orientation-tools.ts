/**
 * The builder's six `orient_*` tools: thin wrappers over `OrientationService`. Every call is checked
 * against the store by the calling thread's id (bb supplies it), so a thread that is not building an
 * orientation is refused whatever tools it was handed. The plugin captures a listing's code from the
 * file itself; the agent never pastes code. Refusals come back as tool errors the agent can act on.
 */
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { ORIENT_LIMITS, OrientationSummarySchema } from "../shared/orientation";
import { OrientationError, type OrientationService } from "./orientation";

export const ORIENT_TOOL_NAMES = ["orient_chapter", "orient_note", "orient_listing", "orient_pop", "orient_summary", "orient_finish"] as const;

async function guarded(work: () => Promise<string>): Promise<PluginAgentToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OrientationError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
}

export function registerOrientationTools(bb: BbPluginApi, orientations: OrientationService): void {
  bb.agents.registerTool({
    name: "orient_chapter",
    description: "Start a new chapter of the walkthrough with a short title.",
    presentation: { label: { pending: "Adding a chapter", completed: "Added a chapter" }, icon: { glyph: "Brain" } },
    parameters: z.object({ title: z.string().min(1).max(ORIENT_LIMITS.chapterChars).describe("The chapter's title") }),
    execute: ({ title }, ctx) => guarded(() => orientations.chapter(ctx.threadId, title)),
  });

  bb.agents.registerTool({
    name: "orient_note",
    description:
      "Add a prose note to the walkthrough, in Markdown. A note takes no fenced code (use orient_listing for code) and no line that starts with an image.",
    presentation: { label: { pending: "Adding a note", completed: "Added a note" }, icon: { glyph: "Brain" } },
    parameters: z.object({ markdown: z.string().min(1).max(ORIENT_LIMITS.noteChars).describe("The note, in Markdown, without fenced code") }),
    execute: ({ markdown }, ctx) => guarded(() => orientations.note(ctx.threadId, markdown)),
  });

  bb.agents.registerTool({
    name: "orient_listing",
    description:
      "Add a listing: the plugin reads the lines from the file and captures the code itself, so never paste code. Name the file, the lines and a caption.",
    presentation: { label: { pending: "Adding a listing", completed: "Added a listing" }, icon: { glyph: "Brain" } },
    parameters: z.object({
      path: z.string().min(1).max(500).describe("Workspace-relative path of the file"),
      lines: z.string().min(1).max(40).describe('The lines to show, "40-72" or "40"'),
      caption: z.string().min(1).max(ORIENT_LIMITS.captionChars).describe("One line saying what the reader should see"),
    }),
    execute: ({ path, lines, caption }, ctx) => guarded(() => orientations.listing(ctx.threadId, { path, lines, caption })),
  });

  bb.agents.registerTool({
    name: "orient_pop",
    description: "Remove the last block you added to the walkthrough.",
    presentation: { label: { pending: "Removing the last block", completed: "Removed the last block" }, icon: { glyph: "Brain" } },
    parameters: z.object({}),
    execute: (_input, ctx) => guarded(() => orientations.pop(ctx.threadId)),
  });

  bb.agents.registerTool({
    name: "orient_summary",
    description: "Record the orientation's summary: purpose, languages, stages, key files, concepts, gotchas, exercises and sources.",
    presentation: { label: { pending: "Recording the summary", completed: "Recorded the summary" }, icon: { glyph: "Brain" } },
    parameters: OrientationSummarySchema,
    execute: (summary, ctx) => guarded(() => orientations.summary(ctx.threadId, summary)),
  });

  bb.agents.registerTool({
    name: "orient_finish",
    description: "Finish the orientation. Call this last, after the summary and every chapter.",
    presentation: { label: { pending: "Finishing the orientation", completed: "Finished the orientation" }, icon: { glyph: "Brain" } },
    parameters: z.object({}),
    execute: (_input, ctx) => guarded(() => orientations.finish(ctx.threadId)),
  });
}
