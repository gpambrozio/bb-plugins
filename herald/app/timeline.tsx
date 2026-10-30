/**
 * Herald's past sentences in the thread's timeline, through bb 0.48.1's
 * message metadata: each one a card, as the composer banner used to be, drawn
 * above the message that led to its event (`server/placement.ts`) — the
 * slot draws above a message and never below one — with a Read again button.
 * On an older bb the slot is not there and nothing is registered: the Herald
 * tab and page carry the sentences.
 */
import { useRpc, type ExperimentalMessageMetadataProps, type PluginAppSlots } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { Icon } from "@/components/ui/icon";

import type { RpcContract } from "../shared/contract";
import type { AttentionReason, PlacedSentence } from "../shared/herald";
import { HERALD_ICONS } from "./icons";
import { readAgain } from "./panel";
import { canPlaySpeech } from "./speech";
import { timelineSentences, type LoadPlaced } from "./timeline-store";
import { TipButton } from "./tip-button";

export const TIMELINE_SENTENCES_ID = "sentences";

const LABELS: Record<AttentionReason, string> = {
  question: "Question",
  plan: "Plan to approve",
  permission: "Permission",
  finished: "Finished",
  error: "Error",
};

/** Registers the sentences above messages where this bb has the slot; says whether it did. */
export function registerTimelineSentences(slots: PluginAppSlots): boolean {
  // Read loosely: bb before 0.48.1 has no such slot, whatever the typings say.
  const slot = (slots as Partial<PluginAppSlots>).experimental_messageMetadata;
  if (typeof slot !== "function") return false;
  slot.call(slots, { id: TIMELINE_SENTENCES_ID, placement: "above", component: TimelineSentencesAbove });
  return true;
}

/** How this window reads a thread's placed sentences, for the store. */
export function usePlacedLoader(): LoadPlaced {
  const rpc = useRpc<RpcContract>();
  return useCallback((threadId: string) => rpc.call("history.placed", { threadId }), [rpc]);
}

function useSentencesOf(message: ExperimentalMessageMetadataProps["message"]): PlacedSentence[] {
  const load = usePlacedLoader();
  const { threadId, id } = message;
  const subscribe = useCallback((listener: () => void) => timelineSentences.subscribe(threadId, listener), [threadId]);
  const data = useSyncExternalStore(subscribe, () => timelineSentences.snapshot(threadId));
  useEffect(() => timelineSentences.shown(threadId, load), [load, threadId]);
  // The server lists them newest first; on one message they read oldest first.
  return useMemo(() => (data?.sentences ?? []).filter((sentence) => sentence.messageId === id).reverse(), [data, id]);
}

export function TimelineSentencesAbove({ message }: ExperimentalMessageMetadataProps) {
  const sentences = useSentencesOf(message);
  if (sentences.length === 0) return null;
  // bb's metadata row is small, muted and aligned to the message's side; the
  // card takes the whole line and sets its own size and colour.
  return (
    <div className="flex min-w-0 basis-full flex-col gap-1.5" data-herald-sentences="">
      {sentences.map((sentence) => (
        <SentenceCard key={sentence.eventId} sentence={sentence} />
      ))}
    </div>
  );
}

function SentenceCard({ sentence }: { sentence: PlacedSentence }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground">
      <Icon name={HERALD_ICONS.megaphone} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-muted-foreground">Herald · {LABELS[sentence.reason]}</p>
        <p className="whitespace-normal italic" data-herald-sentence="">
          {sentence.text}
        </p>
      </div>
      {canPlaySpeech() ? (
        <TipButton variant="ghost" size="icon" className="size-7 shrink-0" label="Read again" onClick={() => void readAgain(sentence.text)}>
          <Icon name={HERALD_ICONS.volume} />
        </TipButton>
      ) : null}
    </div>
  );
}
