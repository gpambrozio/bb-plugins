/**
 * The sentence above a thread's composer. In Paseo, Herald left a card in the
 * agent's transcript; a bb plugin cannot add a row to a thread's timeline, so
 * the sentence sits where the user is about to answer instead, for as long as
 * the thread waits on them. A kind that is switched off gets no banner.
 */
import { useComposerView } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";

import { speechText } from "../shared/herald";
import { HERALD_ICONS } from "./icons";
import { readAgain, useRows } from "./panel";
import { canPlaySpeech } from "./speech";
import { TipButton } from "./tip-button";

const LABELS = {
  question: "Question",
  plan: "Plan to approve",
  permission: "Permission",
  finished: "Finished",
  error: "Error",
} as const;

export function HeraldBanner() {
  const view = useComposerView();
  const { rows } = useRows();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const row = threadId === null ? undefined : rows?.find((candidate) => candidate.threadId === threadId);
  const entry = row?.entry ?? null;
  if (row === undefined || entry === null || entry.summary.status === "off") return null;
  const sentence = speechText(entry);
  return (
    <div className="flex items-start gap-2 px-3 py-2 text-sm">
      <Icon name={HERALD_ICONS.megaphone} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-muted-foreground">Herald · {LABELS[entry.reason]}</p>
        {sentence !== null ? (
          <p className="italic">{sentence}</p>
        ) : entry.summary.status === "pending" ? (
          <p className="italic text-muted-foreground">Writing the sentence…</p>
        ) : null}
      </div>
      {sentence !== null && canPlaySpeech() ? (
        <TipButton variant="ghost" size="icon" className="size-7 shrink-0" label="Read again" onClick={() => void readAgain(sentence)}>
          <Icon name={HERALD_ICONS.volume} />
        </TipButton>
      ) : null}
    </div>
  );
}
