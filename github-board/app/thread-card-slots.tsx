/**
 * The card a thread was started on, where bb shows a thread: a row in its
 * Info tab (bb 0.47), and an item on its sidebar row's metadata line (bb
 * 0.48, behind bb's `threadRowMetadata` experiment). Both read the card the
 * board's `send` stored as the thread's plugin metadata; a thread without one
 * — Add to chat writes none — shows nothing.
 */
import { useEffect, useRef, useState } from "react";
import {
  experimental_DetailRow as DetailRow,
  experimental_THREAD_INFO_ROW_GROUPS,
  experimental_usePluginId,
  UrlLink,
  useSdk,
  type ExperimentalThreadInfoProps,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
  type PluginAppSlots,
} from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";
import { isOpenableLink } from "./link";
import { batches, cardFromMetadata, cardReference, threadsToRead, type ThreadCard } from "./thread-card";

/** The Info tab row: the card's reference, linked to GitHub, and its title. */
export function ThreadCardInfoRow({ threadId }: ExperimentalThreadInfoProps) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [card, setCard] = useState<ThreadCard | null>(null);

  useEffect(() => {
    setCard(null);
    const controller = new AbortController();
    sdkRef.current.threads.getPluginMetadata({ threadId, signal: controller.signal }).then(
      (metadata) => {
        if (!controller.signal.aborted) setCard(cardFromMetadata(metadata));
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // The row is an extra; without the metadata it shows nothing.
        console.warn(`github-board: could not read the card of thread ${threadId}: ${describe(error)}`);
      },
    );
    return () => controller.abort();
  }, [threadId]);

  if (card === null) return null;
  const reference = cardReference(card);
  return (
    <DetailRow label="GitHub card" icon="Github">
      <span className="flex min-w-0 items-baseline gap-2">
        {isOpenableLink(card.url) ? (
          <UrlLink
            href={card.url}
            className="shrink-0 text-primary hover:underline"
            aria-label={`Open ${reference} on GitHub`}
          >
            {reference}
          </UrlLink>
        ) : (
          <span className="shrink-0">{reference}</span>
        )}
        <span className="min-w-0 truncate text-muted-foreground" title={card.title}>
          {card.title}
        </span>
      </span>
    </DetailRow>
  );
}

export type ThreadCards = ReadonlyMap<string, ThreadCard | null>;

/**
 * The cards of every listed thread the board started, read in batches of 200.
 * bb calls it once for the whole app, and only while a list draws a metadata
 * line — never while the experiment or the user's Metadata row option is off.
 * A card never changes after the spawn, so each thread is read once; a failed
 * batch is read again the next time bb hands over the list.
 */
export function useThreadCards({ threads }: ExperimentalThreadRowMetadataDataInput): ThreadCards {
  const pluginId = experimental_usePluginId();
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [cards, setCards] = useState<ThreadCards>(() => new Map());
  const requested = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const key = threadsToRead(threads, pluginId, requested.current).join("\n");
  // While a read has failed, every new list from bb runs the effect again,
  // which asks for the failed threads once more; otherwise only new threads do.
  const retryOn = failed.current.size > 0 ? threads : null;

  useEffect(() => {
    if (key === "") return;
    const ids = key.split("\n");
    for (const id of ids) requested.current.add(id);
    for (const batch of batches(ids)) {
      sdkRef.current.threads.experimental_listPluginMetadata({ threadIds: batch }).then(
        (result) => {
          for (const id of batch) failed.current.delete(id);
          setCards((previous) => {
            const next = new Map(previous);
            for (const id of batch) next.set(id, null);
            for (const row of result.threads) next.set(row.threadId, cardFromMetadata(row.metadata));
            return next;
          });
        },
        (error: unknown) => {
          for (const id of batch) {
            requested.current.delete(id);
            failed.current.add(id);
          }
          console.warn(`github-board: could not read the cards of ${batch.length} threads: ${describe(error)}`);
        },
      );
    }
  }, [key, retryOn]);

  return cards;
}

/** The sidebar row item: the GitHub mark and `repo#123`, the full reference and title in its tooltip. */
export function ThreadCardRowItem({ thread, data }: ExperimentalThreadRowMetadataProps<ThreadCards>) {
  const card = data.get(thread.id);
  if (card === undefined || card === null) return null;
  const reference = cardReference(card);
  const name = card.repository.slice(card.repository.lastIndexOf("/") + 1);
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground"
      title={`${reference}: ${card.title}`}
      aria-label={`GitHub card ${reference}: ${card.title}`}
    >
      <Icon name="Github" className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {name}#{card.number}
      </span>
    </span>
  );
}

/**
 * Registers both surfaces. The sidebar item's slot is new in bb 0.48, so on
 * bb 0.47 it is left out rather than raising the plugin's minimum bb for an
 * item behind an experiment.
 */
export function registerThreadCard(slots: PluginAppSlots): void {
  slots.experimental_threadInfoRow({
    id: "card",
    group: experimental_THREAD_INFO_ROW_GROUPS.thread,
    component: ThreadCardInfoRow,
  });
  const partial = slots as Partial<Pick<PluginAppSlots, "experimental_threadRowMetadata">>;
  if (typeof partial.experimental_threadRowMetadata === "function") {
    partial.experimental_threadRowMetadata<ThreadCards>({
      id: "card",
      useData: useThreadCards,
      component: ThreadCardRowItem,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
