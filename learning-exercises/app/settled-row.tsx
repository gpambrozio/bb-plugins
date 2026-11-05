/**
 * A settled card in the transcript: the question and the learner's own words, with how sure they were.
 * Only what `describeSubmission` kept is here (`SettledRowSchema`), never the agent's verdict, so the
 * row shows exactly what the learner said and nothing credited to them. A form answer is shown part by
 * part (`AnswerView`); a row whose form no longer reads shows the answer's text summary.
 */
import type { PluginTimelineRendererProps } from "@get-bb/plugin-sdk/app";

import { FormValuesSchema, readAnswerForm } from "../shared/answer-form";
import { CONFIDENCE_LABELS, SettledRowSchema } from "../shared/types";
import { AnswerView } from "./answer-form";
import { FileMarkdown } from "./file-refs";

const ACTIONS = {
  skip: "Skipped.",
  "more-specific": "Asked for a more specific question.",
  pause: "Paused the session.",
} as const;

export function SettledRow({ payload, Original }: PluginTimelineRendererProps) {
  const parsed = SettledRowSchema.safeParse(payload);
  if (!parsed.success) return <Original />;
  const row = parsed.data;
  const form = readAnswerForm(row.form);
  const fields = FormValuesSchema.safeParse(row.fields);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <FileMarkdown content={row.question} workspace={row.workspace} className="text-muted-foreground" />
      {row.action === "answer" ? (
        <>
          {form !== null && fields.success ? (
            <AnswerView form={form} fields={fields.data} workspace={row.workspace ?? null} className="border-l-2 border-border pl-3" />
          ) : (
            <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3">{row.answer}</blockquote>
          )}
          {row.confidence !== null && (
            <span className="text-xs text-muted-foreground">
              Confidence {row.confidence}/5 · {CONFIDENCE_LABELS[row.confidence]}
            </span>
          )}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{ACTIONS[row.action]}</span>
      )}
    </div>
  );
}
