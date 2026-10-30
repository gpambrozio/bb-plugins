/**
 * Herald's past sentences in the thread's timeline, through bb 0.48.1's
 * message metadata: each one drawn above the first message after its event
 * (`server/placement.ts`), small and muted, with a Read again button. On an
 * older bb the slot is not there and nothing is registered: the composer
 * banner and the Herald tab carry the sentences, as before.
 */
import { useRpc, type ExperimentalMessageMetadataProps, type PluginAppSlots } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { RpcContract } from "../shared/contract";
import type { PlacedSentence } from "../shared/herald";
import { HERALD_ICONS } from "./icons";
import { readAgain } from "./panel";
import { canPlaySpeech } from "./speech";
import { timelineSentences, type LoadPlaced } from "./timeline-store";
import { TipButton } from "./tip-button";

export const TIMELINE_SENTENCES_ID = "sentences";

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

function useSentencesAbove(message: ExperimentalMessageMetadataProps["message"]): PlacedSentence[] {
  const load = usePlacedLoader();
  const { threadId, id, createdAt } = message;
  const subscribe = useCallback((listener: () => void) => timelineSentences.subscribe(threadId, listener), [threadId]);
  const data = useSyncExternalStore(subscribe, () => timelineSentences.snapshot(threadId));
  // Again whenever the places change: a message newer than a sentence still waiting asks once.
  useEffect(() => timelineSentences.shown(threadId, { id, createdAt }, load), [data, load, threadId, id, createdAt]);
  // The server lists them newest first; above one message they read oldest first.
  return useMemo(() => (data?.sentences ?? []).filter((sentence) => sentence.messageId === id).reverse(), [data, id]);
}

export function TimelineSentencesAbove({ message }: ExperimentalMessageMetadataProps) {
  const sentences = useSentencesAbove(message);
  if (sentences.length === 0) return null;
  // bb aligns metadata to the message's side; these speak for the agent, so
  // they take the whole line and start on its side, as an answer's do.
  return (
    <div className={cn("flex min-w-0 basis-full flex-col gap-0.5", message.role === "user" && "pl-2")} data-herald-sentences="">
      {sentences.map((sentence) => (
        <div key={sentence.eventId} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name={HERALD_ICONS.megaphone} className="size-3.5 shrink-0" aria-label="Herald" />
          <span className="min-w-0 italic" data-herald-sentence="">
            {sentence.text}
          </span>
          {canPlaySpeech() ? (
            <TipButton variant="ghost" size="icon" className="size-5 shrink-0" label="Read again" onClick={() => void readAgain(sentence.text)}>
              <Icon name={HERALD_ICONS.volume} className="size-3.5" />
            </TipButton>
          ) : null}
        </div>
      ))}
    </div>
  );
}
