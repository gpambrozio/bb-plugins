/**
 * The exercise card (feature #6): the question, the files to open, the learner's answer and how sure
 * they are, with Skip, "Make it more specific" and Pause. It holds the pause the upstream skill asks the
 * model to keep: the agent's turn is over while the card is open, and nothing suggests an answer.
 *
 * bb draws it where the composer is, so while it is open the user answers it, skips it or pauses the
 * session (spike S3). Every button is `type="button"`. When the agent sent an answer form, its controls
 * replace the text box (`answer-form.tsx`); a form this build cannot read falls back to the text box. File references in the question and the files to open
 * are links that open the file in bb, at a line or range when they name one (`file-refs.tsx`).
 *
 * What the learner has typed but not sent is saved with the question as they go and restored when the card
 * mounts again (`draft.ts`): leaving the thread, a reload or another device keeps it.
 *
 * Above the question, the agent's reply to the previous one (`previous`): its feedback, which bb folds
 * away with the turn that wrote it once the turn ends with this card. It is open, and can be closed.
 */
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { draftValues, formProblems, hasAnyAnswer, initialValues, readAnswerForm, sanitizeValues, summarizeAnswer, type AnswerForm, type FormValues } from "../shared/answer-form";
import { ANSWER_MAX_CHARS, CardPayloadSchema, CONFIDENCE_LABELS, type CardDraft, type CardValue } from "../shared/types";
import { AnswerFormFields } from "./answer-form";
import { useCardDraft } from "./draft";
import { FileMarkdown, FileRef } from "./file-refs";

const LARGE_ANSWER = new Set(["generation", "teach-back", "trace"]);

export function ExerciseCard({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = CardPayloadSchema.safeParse(interaction.payload);
  // A form this build cannot read falls back to the plain text box (the server takes a text answer then).
  const form = useMemo(() => {
    const payload = CardPayloadSchema.safeParse(interaction.payload);
    return payload.success ? readAnswerForm(payload.data.form) : null;
  }, [interaction.payload]);
  const [values, setValues] = useState<FormValues | null>(null);
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const question = parsed.success ? { sessionId: parsed.data.sessionId, ordinal: parsed.data.ordinal } : { sessionId: "", ordinal: 0 };
  const draft: CardDraft = form === null ? { answer, confidence } : { fields: values ?? initialValues(form), confidence };
  const drafts = useCardDraft(question, draft, (saved) => {
    // The server read it against the form already; reading it again here keeps a bad value off the controls.
    if (form !== null && saved.fields !== undefined) setValues(draftValues(form, saved.fields));
    if (form === null && saved.answer !== undefined) setAnswer(saved.answer.slice(0, ANSWER_MAX_CHARS));
    if (saved.confidence !== undefined) setConfidence(saved.confidence);
  });
  if (!parsed.success) return <div className="p-3 text-sm text-destructive">This exercise card cannot be shown.</div>;
  const card = parsed.data;
  const send = (value: CardValue) => {
    // A pause keeps the question, so its draft is saved first; anything else ends the question and its draft.
    if (value.action === "pause") drafts.flush();
    else drafts.stop();
    setSending(true);
    submit(value).catch(() => {
      drafts.resume();
      setSending(false);
    });
  };
  const tooLong = answer.length > ANSWER_MAX_CHARS;
  const nearLimit = answer.length >= ANSWER_MAX_CHARS * 0.9;
  const formValues = form === null ? null : (values ?? initialValues(form));
  const formState = form === null || formValues === null ? null : formStateOf(form, formValues);
  const answered = formState === null ? answer.trim() !== "" && !tooLong : formState.ready;
  const ready = answered && confidence !== null && !sending;
  const submit_ = () => {
    if (form !== null && formValues !== null) {
      // What the server will keep: unticked boxes of a decided table as false, empty list entries dropped.
      const fields = sanitizeValues(form, formValues);
      send({ action: "answer", answer: summarizeAnswer(form, fields).slice(0, ANSWER_MAX_CHARS), confidence: confidence ?? 3, fields });
    } else {
      send({ action: "answer", answer: answer.trim(), confidence: confidence ?? 3 });
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-sm" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Question {card.ordinal} of at most {card.maxQuestions}
        </span>
        <span className="truncate">{card.topic.replace(/[`"]/g, "")}</span>
      </div>
      {card.previous !== undefined && (
        <details open className="group rounded-md border border-border">
          <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {card.previous.answered ? `Feedback on question ${card.previous.ordinal}` : `After question ${card.previous.ordinal}`}
          </summary>
          <div className="max-h-72 overflow-y-auto border-t border-border px-2 py-1.5">
            <FileMarkdown content={card.previous.reply} workspace={card.workspace} className="text-sm" />
          </div>
        </details>
      )}
      <FileMarkdown content={card.question} workspace={card.workspace} className="text-sm" />
      {card.files.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Open:</span>
          {card.files.map((reference) => (
            <FileRef key={reference} reference={reference} environmentId={card.environmentId} />
          ))}
        </div>
      )}
      {form !== null && formValues !== null && formState !== null ? (
        <>
          <AnswerFormFields form={form} values={formValues} disabled={sending} workspace={card.workspace ?? null} onChange={(id, value) => {
              drafts.edited();
              setValues({ ...formValues, [id]: value });
            }} />
          {formState.waiting.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Still to answer: {formState.waiting.join("; ")}.
            </p>
          )}
        </>
      ) : (
        <>
          <textarea
            aria-label="Your answer"
            className={cn(
              "w-full resize-y rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              LARGE_ANSWER.has(card.type) ? "min-h-32 font-mono" : "min-h-20",
            )}
            placeholder="Your answer, in your own words. Wrong guesses are useful data."
            value={answer}
            maxLength={ANSWER_MAX_CHARS}
            disabled={sending}
            onChange={(event) => {
              drafts.edited();
              setAnswer(event.target.value);
            }}
          />
          {nearLimit && (
            <p className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")} role="status">
              {answer.length.toLocaleString()} of {ANSWER_MAX_CHARS.toLocaleString()} characters
              {answer.length >= ANSWER_MAX_CHARS ? ". Answers stop here; shorten it to add more." : "."}
            </p>
          )}
        </>
      )}
      <fieldset className="flex flex-wrap items-center gap-1.5" disabled={sending}>
        <legend className="mb-1 text-xs text-muted-foreground">How sure are you?</legend>
        {[1, 2, 3, 4, 5].map((level) => (
          <Button
            key={level}
            type="button"
            size="sm"
            variant={confidence === level ? "default" : "outline"}
            aria-pressed={confidence === level}
            onClick={() => {
              drafts.edited();
              setConfidence(level);
            }}
          >
            {level} · {CONFIDENCE_LABELS[level]}
          </Button>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" disabled={!ready} onClick={submit_}>
          Submit
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => send({ action: "more-specific" })}>
          Make it more specific
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => send({ action: "skip" })}>
          Skip
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => send({ action: "pause" })}>
          Pause session
        </Button>
      </div>
    </div>
  );
}

/** Whether a form answer can be sent, and what still holds it back, label by label. */
function formStateOf(form: AnswerForm, values: FormValues): { ready: boolean; waiting: string[] } {
  const problems = formProblems(form, values);
  const labels = new Map(form.items.flatMap((item) => (item.kind === "section" || item.kind === "note" ? [] : [[item.id, item.label] as const])));
  const waiting = [...problems].map(([id, problem]) => `${labels.get(id) ?? id} ${problem}`);
  if (problems.size === 0 && !hasAnyAnswer(form, values)) return { ready: false, waiting: ["at least one part"] };
  return { ready: problems.size === 0, waiting };
}
