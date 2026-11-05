/**
 * The session tools: `learning_ask`, `learning_feedback`, `learning_finish`. `bb.agents.configure`
 * offers them only to a thread whose plugin metadata names an open session (`server.ts`), so a thread
 * that never accepted a session never sees their schemas. Every call is then checked against the store
 * by the calling thread's id, which bb supplies: metadata the agent could write itself unlocks nothing.
 * Refusals come back as tool errors the agent can act on.
 */
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { AnswerFormSchema } from "../shared/answer-form";
import { EXERCISE_TYPES, QUESTION_MAX_CHARS, VERDICTS } from "../shared/types";
import { SessionError, type SessionService } from "./sessions";

export const TOOL_NAMES = ["learning_ask", "learning_feedback", "learning_finish"] as const;

async function guarded(work: () => Promise<string>): Promise<PluginAgentToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
}

const concepts = z.array(z.string().min(1).max(80)).max(20).optional().describe("Concepts the question exercised, a few words each");

export function registerTools(bb: BbPluginApi, sessions: SessionService): void {
  bb.agents.registerTool({
    name: "learning_ask",
    description:
      "Show the learner one exercise question in a card and wait for their answer, which comes back as this tool's result. Ask exactly one question per call, then end your turn and add nothing. The question must stand on its own: the card is all the learner sees while answering.",
    instructions:
      "In this learning session every question goes through learning_ask. Write nothing after calling it: no hints, no example answers, no second question. Make every question self-contained: put any code it relies on inside the question as a fenced code block, above all code the files do not hold as they are now (an earlier version, a proposed change), and never refer to \"above\", \"earlier\" or a previous message.",
    presentation: { label: { pending: "Asking an exercise question", completed: "Asked an exercise question" }, icon: { glyph: "Brain" }, suppress: true },
    parameters: z.object({
      type: z.enum(EXERCISE_TYPES).describe("The exercise type"),
      question: z
        .string()
        .min(1)
        .max(QUESTION_MAX_CHARS)
        .describe(
          "The full question, in Markdown, self-contained: include any code it relies on as a fenced code block (code not in the files as they are now, such as an earlier version, must be here), and never point to \"above\" or an earlier message. Write file references as workspace-relative paths in backticks, with a line or range when you mean one (`src/a.ts:42`), so they open as links",
        ),
      files: z.array(z.string().min(1).max(500)).max(10).optional().describe("Workspace-relative paths the learner should open, each with an optional line or range: src/a.ts, src/a.ts:42, src/a.ts:40-60"),
      form: AnswerFormSchema.optional().describe(
        "Optional answer form, for a question with several parts or a shape a text box serves badly. Leave it out for one plain text answer (the default). Pick the simplest control that fits; see the brief's 'Answer forms'. An invalid form is refused with the reasons and nothing is shown",
      ),
    }),
    execute: ({ type, question, files, form }, ctx) => guarded(() => sessions.ask(ctx.threadId, { type, question, files: files ?? [], form }, "tool", ctx.signal)),
  });

  bb.agents.registerTool({
    name: "learning_feedback",
    description:
      "Record your verdict on the learner's last answer, the gap you saw, and the concepts involved. Call it after giving them your feedback as a message; the plugin keeps that message with the question and shows it above the next one.",
    presentation: { label: { pending: "Recording feedback", completed: "Recorded feedback" }, icon: { glyph: "Brain" }, suppress: true },
    parameters: z.object({
      verdict: z.enum(VERDICTS),
      gap: z.string().max(500).optional().describe("What was missing or wrong, in one sentence"),
      concepts,
    }),
    execute: ({ verdict, gap, concepts: named }, ctx) => guarded(() => sessions.feedback(ctx.threadId, { verdict, gap: gap ?? null, concepts: named ?? [] })),
  });

  bb.agents.registerTool({
    name: "learning_finish",
    description: "End the learning session with a two-sentence summary of what was covered and how it went.",
    presentation: { label: { pending: "Finishing the learning session", completed: "Finished the learning session" }, icon: { glyph: "Brain" } },
    parameters: z.object({ summary: z.string().min(1).max(1000), concepts }),
    execute: ({ summary, concepts: named }, ctx) => guarded(() => sessions.finishFromAgent(ctx.threadId, { summary, concepts: named ?? [] })),
  });
}
