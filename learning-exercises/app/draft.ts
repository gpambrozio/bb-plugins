/**
 * A card's unsent answer, kept on the server with its question (`saveDraft`, `cardDraft`), so it survives
 * leaving the thread (which unmounts the card), a reload and another device.
 *
 * - On mount the card asks for its draft and restores it, unless the learner has already typed: their
 *   own input wins.
 * - Edits are saved after `DRAFT_SAVE_DELAY_MS` of quiet. A save still waiting when the card unmounts or
 *   the page is hidden goes at once.
 * - After an answer, a skip or "more specific" nothing more is saved: the server clears the draft with
 *   the question, and refuses a save that lands later. A pause saves first: the question will come back.
 *
 * Saving is best effort: a failed save is logged and the card keeps working.
 */
import { useEffect, useRef } from "react";

import type { CardDraft } from "../shared/types";
import { useLearningRpc } from "./data";

export const DRAFT_SAVE_DELAY_MS = 500;

export interface CardDraftHandle {
  /** Marks the learner's own edit: from now on the draft is theirs, and a late restore is dropped. */
  edited(): void;
  /** Saves now whatever is waiting (before a pause). */
  flush(): void;
  /** No more saves: the question is answered or skipped. */
  stop(): void;
  /** Saves again: the submit failed, so the card is still open. */
  resume(): void;
}

export function useCardDraft(question: { sessionId: string; ordinal: number }, draft: CardDraft, restore: (draft: CardDraft) => void): CardDraftHandle {
  const rpc = useLearningRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const touched = useRef(false);
  const stopped = useRef(false);
  const pending = useRef<CardDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { sessionId, ordinal } = question;

  const save = useRef(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null || stopped.current) return;
    rpcRef.current.call("saveDraft", { sessionId, ordinal, draft: next }).catch((error: unknown) => {
      console.warn(`Learning Exercises: could not save the unsent answer to question ${ordinal}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }).current;

  // Restore once, on mount.
  useEffect(() => {
    let live = true;
    rpcRef.current
      .call("cardDraft", { sessionId, ordinal })
      .then((saved) => {
        if (live && saved !== null && !touched.current && !stopped.current) restoreRef.current(saved);
      })
      .catch((error: unknown) => {
        console.warn(`Learning Exercises: could not read the unsent answer to question ${ordinal}: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      live = false;
    };
  }, [sessionId, ordinal]);

  // Each edit (re)starts the wait; the draft is the card's whole answer state, so the latest one wins.
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (!touched.current || stopped.current) return;
    pending.current = JSON.parse(serialized) as CardDraft;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(save, DRAFT_SAVE_DELAY_MS);
  }, [serialized, save]);

  // Leaving the thread unmounts the card; hiding the page may end it. Either way, save what is waiting.
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);

  return {
    edited: () => {
      touched.current = true;
    },
    flush: save,
    stop: () => {
      stopped.current = true;
      pending.current = null;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    resume: () => {
      stopped.current = false;
    },
  };
}
