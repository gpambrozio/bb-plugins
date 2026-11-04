/**
 * The exercise card (feature #6): the question, the files to open, the learner's answer and how sure
 * they are, with Skip, "Make it more specific" and Pause. It holds the pause the upstream skill asks the
 * model to keep: the agent's turn is over while the card is open, and nothing suggests an answer.
 *
 * bb draws it where the composer is, so while it is open the user answers it, skips it or pauses the
 * session (spike S3). Every button is `type="button"`. File references in the question and the files to open
 * are links that open the file in bb, at a line or range when they name one (`file-refs.tsx`).
 */
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ANSWER_MAX_CHARS, CardPayloadSchema, CONFIDENCE_LABELS, type CardValue } from "../shared/types";
import { FileMarkdown, FileRef } from "./file-refs";

const LARGE_ANSWER = new Set(["generation", "teach-back", "trace"]);

export function ExerciseCard({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = CardPayloadSchema.safeParse(interaction.payload);
  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  if (!parsed.success) return <div className="p-3 text-sm text-destructive">This exercise card cannot be shown.</div>;
  const card = parsed.data;
  const send = (value: CardValue) => {
    setSending(true);
    submit(value).catch(() => setSending(false));
  };
  const tooLong = answer.length > ANSWER_MAX_CHARS;
  const ready = answer.trim() !== "" && !tooLong && confidence !== null && !sending;
  const nearLimit = answer.length >= ANSWER_MAX_CHARS * 0.9;

  return (
    <div className="flex flex-col gap-3 p-3 text-sm" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Question {card.ordinal} of at most {card.maxQuestions}
        </span>
        <span className="truncate">{card.topic.replace(/[`"]/g, "")}</span>
      </div>
      <FileMarkdown content={card.question} workspace={card.workspace} className="text-sm" />
      {card.files.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Open:</span>
          {card.files.map((reference) => (
            <FileRef key={reference} reference={reference} environmentId={card.environmentId} />
          ))}
        </div>
      )}
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
        onChange={(event) => setAnswer(event.target.value)}
      />
      {nearLimit && (
        <p className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")} role="status">
          {answer.length.toLocaleString()} of {ANSWER_MAX_CHARS.toLocaleString()} characters
          {answer.length >= ANSWER_MAX_CHARS ? ". Answers stop here; shorten it to add more." : "."}
        </p>
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
            onClick={() => setConfidence(level)}
          >
            {level} · {CONFIDENCE_LABELS[level]}
          </Button>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" disabled={!ready} onClick={() => send({ action: "answer", answer: answer.trim(), confidence: confidence ?? 3 })}>
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
