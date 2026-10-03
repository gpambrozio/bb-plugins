/**
 * The sentence above a thread's composer. In Paseo, Herald left a card in the
 * agent's transcript; a bb plugin cannot add a row to a thread's timeline, so
 * the sentence sits where the user is about to answer instead — and stays,
 * read or not, through the next turn, until the next event replaces it. A
 * kind that is switched off gets no banner.
 */
import { useComposer } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";

import { speechText } from "../shared/herald";
import { HERALD_ICONS } from "./icons";
import { useEntries } from "./entries";
import { readAgain } from "./panel";
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
  const { scope } = useComposer();
  const { entries } = useEntries();
  // The banner is registered for thread composers only. bb 0.44 reports the
  // thread's queued message instead while the user edits one, so that counts
  // as the thread too.
  const threadId = scope.kind === "thread" || scope.kind === "queued-message" ? scope.threadId : null;
  // Herald's own entry, not the panel's join with bb's unread state: the
  // sentence stays here once the thread is read, and through the next turn,
  // until the next event replaces it.
  const entry = threadId === null ? undefined : entries?.find((candidate) => candidate.threadId === threadId);
  if (entry === undefined || entry.summary.status === "off") return null;
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
