/**
 * The agent's feedback in the chat: a card with the verdict and the feedback, drawn above the last message
 * of the turn that recorded it, through bb's message metadata (`experimental_messageMetadata`, "above";
 * there is no slot below a message, and a plugin cannot add a row of its own).
 *
 * bb folds a finished turn's work and its earlier messages into one "Worked for" row, and the question
 * card's own row is part of that work, so neither the feedback message nor the card stays in view. What
 * stays is the turn's last message ("I've asked the next question…", the closing line). The server keeps
 * the feedback with the id of the turn it was recorded in (`feedbackCards`); here each message of that
 * turn on screen registers, and the newest one draws the card. While the turn runs that is its newest
 * message, so the card moves down with it; once the turn folds, only the last message is on screen.
 * An assistant message wins over the turn's prompt, which stands in only when the turn wrote nothing.
 *
 * Nothing is drawn from the timeline itself: a reload, another window and another device read the same
 * stored feedback and the same turn ids.
 */
import { experimental_useRpcQuery, type ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { rpcContract } from "../shared/contract";
import type { FeedbackCard as FeedbackCardData, Verdict } from "../shared/types";
import { FileMarkdown } from "./file-refs";

export const FEEDBACK_METADATA_ID = "feedback";

const VERDICT_LABELS: Record<Verdict, string> = {
  correct: "Correct",
  partly: "Partly right",
  incorrect: "Not quite",
  skipped: "Skipped",
};

const VERDICT_TONES: Record<Verdict, string> = {
  correct: "text-success",
  partly: "text-warning-text",
  incorrect: "text-destructive",
  skipped: "text-muted-foreground",
};

type MessageContext = ExperimentalMessageMetadataProps["message"];

interface Mounted {
  createdAt: number;
  assistant: boolean;
  /** The same message can be on screen twice (two panes on one thread). */
  count: number;
}

/** The messages on screen of each turn that has a feedback card, by `threadId` and `turnId`. */
const turns = new Map<string, Map<string, Mounted>>();
const listeners = new Set<() => void>();

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function mount(key: string, id: string, entry: Omit<Mounted, "count">): () => void {
  let messages = turns.get(key);
  if (messages === undefined) turns.set(key, (messages = new Map()));
  const known = messages.get(id);
  messages.set(id, { ...entry, count: (known?.count ?? 0) + 1 });
  notify();
  return () => {
    const current = turns.get(key)?.get(id);
    if (current === undefined) return;
    if (current.count > 1) turns.get(key)!.set(id, { ...current, count: current.count - 1 });
    else {
      turns.get(key)!.delete(id);
      if (turns.get(key)!.size === 0) turns.delete(key);
    }
    notify();
  };
}

/** The message a turn's card is drawn above: its newest assistant message on screen, else its newest message. */
function anchorOf(key: string): string | null {
  let best: { id: string; entry: Mounted } | null = null;
  for (const [id, entry] of turns.get(key) ?? []) {
    const better =
      best === null ||
      (entry.assistant && !best.entry.assistant) ||
      (entry.assistant === best.entry.assistant && (entry.createdAt > best.entry.createdAt || (entry.createdAt === best.entry.createdAt && id > best.id)));
    if (better) best = { id, entry };
  }
  return best?.id ?? null;
}

/** Whether this message is where its turn's card goes; only messages of a turn with a card take part. */
function useIsAnchor(message: MessageContext, active: boolean): boolean {
  const key = message.turnId === null ? null : turnKey(message.threadId, message.turnId);
  const { id, createdAt, role } = message;
  useEffect(() => (active && key !== null ? mount(key, id, { createdAt, assistant: role === "assistant" }) : undefined), [active, key, id, createdAt, role]);
  const anchor = useSyncExternalStore(
    subscribe,
    useCallback(() => (active && key !== null ? anchorOf(key) : null), [active, key]),
  );
  return active && anchor === id;
}

export function FeedbackAboveMessage({ message }: ExperimentalMessageMetadataProps) {
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "feedbackCards", input: { threadId: message.threadId } });
  const cards = message.turnId === null ? [] : (data?.cards ?? []).filter((card) => card.turnId === message.turnId);
  const anchor = useIsAnchor(message, cards.length > 0);
  if (!anchor) return null;
  // bb's metadata row is small, muted and aligned to the message's side: the cards take the whole line,
  // set their own size and colour, and leave 10 px before the message.
  return (
    <div className="mb-[10px] flex min-w-0 basis-full flex-col gap-1.5" data-learning-feedback="">
      {cards.map((card) => (
        <FeedbackCard key={`${card.sessionId}:${card.ordinal}`} card={card} />
      ))}
    </div>
  );
}

/** Framed as the question card is where bb draws it (a raised card in the theme's tokens). */
export function FeedbackCard({ card }: { card: FeedbackCardData }) {
  return (
    <section aria-label={`Feedback on question ${card.ordinal}`} className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised-solid p-3 text-left text-sm text-foreground">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Feedback on question {card.ordinal}</span>
        {card.verdict !== null && <span className={cn("font-medium", VERDICT_TONES[card.verdict])}>{VERDICT_LABELS[card.verdict]}</span>}
      </div>
      <FileMarkdown content={card.feedback} workspace={card.workspace} className="text-sm" />
    </section>
  );
}
