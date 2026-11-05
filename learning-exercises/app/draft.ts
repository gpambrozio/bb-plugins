/**
 * A card's unsent answer, kept on the server with its question (`saveDraft`, `cardDraft`), so it survives
 * leaving the thread (which unmounts the card), a reload and another device.
 *
 * - **Every edit is a new revision**, higher than any before it on this card or restored from the server.
 *   The server keeps a draft only over a lower revision, so saves that arrive out of order keep the newest.
 * - **The newest unacknowledged edit is also in this browser's storage** (`localStorage`, by session and
 *   question) from the moment it is made until the server has acknowledged a save of it. An unload that
 *   kills the request, or a page closed inside the 500 ms wait, loses nothing on this device: the next
 *   card restores it and sends it again. Storage that throws or is missing (a private window) only loses
 *   that safety net.
 * - **Saves go** `DRAFT_SAVE_DELAY_MS` after the last edit, and at once when the card unmounts, the page
 *   is hidden (`visibilitychange`, which a backgrounded mobile app sends without `pagehide`) or unloaded.
 * - **On mount** the card restores whichever of the server's draft and the stored one is newer, unless the
 *   learner has already typed, and sends the stored one again when the server's is older.
 * - **After an answer, a skip or "more specific"** nothing more is saved and the stored copy goes: the
 *   server clears the draft with the question and refuses a later save. If that submission fails, the
 *   unsent edit comes back and is saved. A pause saves first: the question will come back.
 *
 * Saving is best effort: a failed save is logged, kept in storage, and the card keeps working.
 */
import { useEffect, useRef } from "react";

import { CardDraftSchema, type CardDraft } from "../shared/types";
import { useLearningRpc } from "./data";

export const DRAFT_SAVE_DELAY_MS = 500;

export interface CardDraftHandle {
  /** Marks the learner's own edit: from now on the draft is theirs, and a late restore is dropped. */
  edited(): void;
  /** Saves now whatever is waiting (before a pause). */
  flush(): void;
  /** No more saves: the question is being answered or skipped. */
  stop(): void;
  /** The submission failed and the card is still open: what was unsent is kept and saved again. */
  resume(): void;
}

/** Where this browser keeps a question's unacknowledged edit. */
export function draftStorageKey(sessionId: string, ordinal: number): string {
  return `learning-exercises:draft:${sessionId}:${ordinal}`;
}

function readStored(key: string): CardDraft | null {
  try {
    const text = window.localStorage.getItem(key);
    if (text === null) return null;
    const parsed = CardDraftSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, draft: CardDraft | null): void {
  try {
    if (draft === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage is full, blocked or missing: the server save still runs.
  }
}

function warn(what: string, error: unknown): void {
  console.warn(`Learning Exercises: could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
}

export function useCardDraft(question: { sessionId: string; ordinal: number }, draft: CardDraft, restore: (draft: CardDraft) => void): CardDraftHandle {
  const rpc = useLearningRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const { sessionId, ordinal } = question;
  const key = draftStorageKey(sessionId, ordinal);

  const state = useRef({
    touched: false,
    stopped: false,
    /** The highest revision this card has made or seen. */
    revision: 0,
    /** The newest edit the server has not acknowledged yet; null when there is none. */
    unsent: null as CardDraft | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  }).current;

  const nextRevision = () => {
    state.revision = Math.max(Date.now(), state.revision + 1);
    return state.revision;
  };

  const send = useRef(() => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    const draft = state.unsent;
    if (draft === null || state.stopped) return;
    rpcRef.current
      .call("saveDraft", { sessionId, ordinal, draft })
      .then(() => {
        // The server now holds this revision or a newer one; a newer edit made meanwhile stays unsent.
        if (state.unsent?.revision === draft.revision) {
          state.unsent = null;
          writeStored(key, null);
        }
      })
      .catch((error: unknown) => warn(`save the unsent answer to question ${ordinal}`, error));
  }).current;

  // On mount: the newer of the server's draft and this browser's, and the stored one sent again if the
  // server's is older.
  useEffect(() => {
    let live = true;
    const stored = readStored(key);
    if (stored !== null) state.revision = Math.max(state.revision, stored.revision ?? 0);
    const settle = (server: CardDraft | null) => {
      if (!live) return;
      const serverRevision = server?.revision ?? 0;
      state.revision = Math.max(state.revision, serverRevision);
      const storedIsNewer = stored !== null && (server === null || (stored.revision ?? 0) > serverRevision);
      const newest = storedIsNewer ? stored : server;
      if (newest !== null && !state.touched && !state.stopped) restoreRef.current(newest);
      if (storedIsNewer && !state.touched) {
        state.unsent = stored;
        send();
      } else if (!storedIsNewer && stored !== null) {
        writeStored(key, null);
      }
    };
    rpcRef.current
      .call("cardDraft", { sessionId, ordinal })
      .then(settle)
      .catch((error: unknown) => {
        warn(`read the unsent answer to question ${ordinal}`, error);
        // The server cannot say: what this browser kept is still the learner's latest.
        if (live && stored !== null && !state.touched && !state.stopped) restoreRef.current(stored);
      });
    return () => {
      live = false;
    };
  }, [key, sessionId, ordinal, send, state]);

  // Each edit is a new revision, kept in storage at once and saved after the wait.
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (!state.touched || state.stopped) return;
    const next: CardDraft = { ...(JSON.parse(serialized) as CardDraft), revision: nextRevision() };
    state.unsent = next;
    writeStored(key, next);
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(send, DRAFT_SAVE_DELAY_MS);
  }, [serialized, key, send, state]);

  // Leaving the thread unmounts the card; hiding or unloading the page may end it. Save what is waiting.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") send();
    };
    window.addEventListener("pagehide", send);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", send);
      document.removeEventListener("visibilitychange", hidden);
      send();
    };
  }, [send]);

  return {
    edited: () => {
      state.touched = true;
    },
    flush: send,
    stop: () => {
      state.stopped = true;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      writeStored(key, null);
    },
    resume: () => {
      state.stopped = false;
      if (state.unsent === null) return;
      writeStored(key, state.unsent);
      send();
    },
  };
}
