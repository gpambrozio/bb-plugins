/**
 * A card's unsent answer, kept on the server with its question (`saveDraft`, `cardDraft`), so it survives
 * leaving the thread (which unmounts the card), a reload and another device.
 *
 * - **One question's saves go one at a time, in order** (`enqueue`, module level, so it holds across
 *   mounts of the card): one request in flight at most, and while it runs only the latest snapshot
 *   waits, then goes. The server keeps whatever arrives, so the last save wins. Two devices typing into
 *   the same question at once is out of scope: the last save wins there too.
 * - **A backup of the newest edit stays in this browser's storage** (`localStorage`, by session and
 *   question, every access in try/catch) from the edit until a save of it is confirmed. Each entry holds
 *   the snapshot and the mount that wrote it, and a confirmation removes it only if storage still holds
 *   exactly that snapshot from that mount, so an old card's late callback never removes a newer edit.
 *   An unload that kills the request, or a page closed inside the wait, loses nothing on this device:
 *   the next card restores the backup and sends it again.
 * - **A backup knows what it was built on**: the token of the last server draft this page saw confirmed
 *   or read (`base`; the server's saved-at time, rising per question). On mount the card reads the
 *   server first. If the server's token is still the backup's base, the backup is newer and wins: it is
 *   restored and sent again. If the token has moved (another device saved since), the server's draft wins
 *   and the backup is dropped. A confirmation that finds a newer edit of this page in storage moves that
 *   backup's base along, since the server's change was this page's own.
 * - **Saves go** `DRAFT_SAVE_DELAY_MS` after the last edit, and at once when the card unmounts or the
 *   page is hidden (`visibilitychange`, which a backgrounded mobile app sends without `pagehide`) or
 *   unloaded. An edit made before the server's draft arrives wins over it.
 * - **After an answer, a skip or "more specific"** nothing more is saved and this card's backup goes. If
 *   that submission fails, the unsent edit is put back and saved. A pause saves first.
 * - **Backups of closed questions are swept** (`sweepDrafts`, when a card or the Learning tab mounts):
 *   ones the server says are closed, ones older than `DRAFT_KEEP_MS`, and all but the newest
 *   `DRAFT_SWEEP_MAX`. A card prunes by age and count before it looks for its own backup. Finishing or deleting a session in this browser drops its backups at once
 *   (`forgetSessionDrafts`).
 *
 * Saving is best effort: a failed save is logged, its backup kept, and the card keeps working.
 */
import { useEffect, useRef } from "react";
import { z } from "zod";

import { DRAFT_SWEEP_MAX } from "../shared/contract";
import { CardDraftSchema, type CardDraft, type QuestionRef } from "../shared/types";
import { useLearningRpc } from "./data";

export const DRAFT_SAVE_DELAY_MS = 500;
/** A backup older than this is dropped whatever the server says. */
export const DRAFT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = "learning-exercises:draft:";

/** Where this browser keeps a question's unconfirmed edit. */
export function draftStorageKey(sessionId: string, ordinal: number): string {
  return `${PREFIX}${sessionId}:${ordinal}`;
}

const BackupSchema = z.object({ mount: z.string(), at: z.number(), base: z.number().int().nullable(), draft: CardDraftSchema });
type Backup = z.infer<typeof BackupSchema>;
type Snapshot = { mount: string; draft: CardDraft; base: number | null };

/** Per question, the token of the last server draft this page saw confirmed or read. */
const baselines = new Map<string, number | null>();
type Call = ReturnType<typeof useLearningRpc>["call"];

function warn(what: string, error: unknown): void {
  console.warn(`Learning Exercises: could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
}

function readBackup(key: string): Backup | null {
  try {
    const text = window.localStorage.getItem(key);
    if (text === null) return null;
    const parsed = BackupSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeBackup(key: string, snapshot: Snapshot): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...snapshot, at: Date.now() } satisfies Backup));
  } catch {
    // Storage is full, blocked or missing: the server save still runs.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do without storage.
  }
}

/** Removes a backup only if it still holds exactly `snapshot`, written by its mount. */
function removeBackupIf(key: string, snapshot: Pick<Snapshot, "mount" | "draft">): void {
  const backup = readBackup(key);
  if (backup !== null && backup.mount === snapshot.mount && JSON.stringify(backup.draft) === JSON.stringify(snapshot.draft)) removeKey(key);
}

function backupKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX) === true) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function questionOf(key: string): QuestionRef | null {
  const match = /^(.+):(\d+)$/.exec(key.slice(PREFIX.length));
  return match === null ? null : { sessionId: match[1]!, ordinal: Number(match[2]) };
}

// ── one question's saves, in order ─────────────────────────────────────────

interface Queue {
  sessionId: string;
  ordinal: number;
  call: Call;
  busy: boolean;
  next: Snapshot | null;
}

const queues = new Map<string, Queue>();

/** Sends `snapshot` once the save in flight for its question, if any, is done; only the latest waiting one goes. */
function enqueue(call: Call, question: QuestionRef, snapshot: Snapshot): void {
  const key = draftStorageKey(question.sessionId, question.ordinal);
  const queue = queues.get(key) ?? { ...question, call, busy: false, next: null };
  queue.call = call;
  queue.next = snapshot;
  queues.set(key, queue);
  if (!queue.busy) pump(key, queue);
}

/** Drops a question's waiting snapshot (the one in flight still lands). */
function dropWaiting(question: QuestionRef): void {
  const queue = queues.get(draftStorageKey(question.sessionId, question.ordinal));
  if (queue !== undefined) queue.next = null;
}

function pump(key: string, queue: Queue): void {
  const snapshot = queue.next;
  if (snapshot === null) {
    queues.delete(key);
    return;
  }
  queue.next = null;
  queue.busy = true;
  queue
    .call("saveDraft", { sessionId: queue.sessionId, ordinal: queue.ordinal, draft: snapshot.draft })
    .then(({ saved, token }) => {
      // Not saved: the question is closed, and so is any backup of it.
      if (!saved) {
        removeKey(key);
        return;
      }
      baselines.set(key, token);
      removeBackupIf(key, snapshot);
      // A newer edit of this page built on the same draft: the server's change is this page's own.
      const newer = readBackup(key);
      if (newer !== null && newer.base === snapshot.base) writeBackup(key, { mount: newer.mount, draft: newer.draft, base: token });
    })
    .catch((error: unknown) => warn(`save the unsent answer to question ${queue.ordinal}`, error))
    .finally(() => {
      queue.busy = false;
      pump(key, queue);
    });
}

// ── backups of closed questions ────────────────────────────────────────────

/**
 * Drops this browser's backups that are unreadable, older than `DRAFT_KEEP_MS`, past the newest
 * `DRAFT_SWEEP_MAX`, or of questions the server says are closed. A failed read of the server drops nothing
 * more.
 */
export async function sweepDrafts(call: Call, now = Date.now()): Promise<void> {
  const kept = pruneBackups(now);
  if (kept.length === 0) return;
  try {
    const { open } = await call("openQuestions", { questions: kept.map((entry) => entry.question) });
    const isOpen = new Set(open.map((question) => draftStorageKey(question.sessionId, question.ordinal)));
    for (const entry of kept) if (!isOpen.has(entry.key) && !queues.has(entry.key)) removeKey(entry.key);
  } catch (error) {
    warn("check which unsent answers are still open", error);
  }
}

/** Drops unreadable backups, ones older than `DRAFT_KEEP_MS` and all but the newest `DRAFT_SWEEP_MAX`; answers the rest. */
function pruneBackups(now = Date.now()): { key: string; question: QuestionRef; at: number }[] {
  const kept: { key: string; question: QuestionRef; at: number }[] = [];
  for (const key of backupKeys()) {
    const backup = readBackup(key);
    const question = questionOf(key);
    if (backup === null || question === null || now - backup.at > DRAFT_KEEP_MS) removeKey(key);
    else kept.push({ key, question, at: backup.at });
  }
  kept.sort((a, b) => b.at - a.at);
  for (const extra of kept.splice(DRAFT_SWEEP_MAX)) removeKey(extra.key);
  return kept;
}

/** Drops a session's backups in this browser (it was finished or deleted here). */
export function forgetSessionDrafts(sessionId: string): void {
  for (const key of backupKeys()) if (questionOf(key)?.sessionId === sessionId) removeKey(key);
}

/** Runs `sweepDrafts` once when the calling component mounts. */
export function useDraftSweep(): void {
  const rpc = useLearningRpc();
  const call = useRef(rpc.call).current;
  useEffect(() => {
    void sweepDrafts(call);
  }, [call]);
}

// ── the card's hook ────────────────────────────────────────────────────────

export interface CardDraftHandle {
  /** Marks the learner's own edit: from now on the draft is theirs, and a late restore is dropped. */
  edited(): void;
  /** Saves now whatever is waiting (before a pause). */
  flush(): void;
  /** No more saves: the question is being answered or skipped. */
  stop(): void;
  /** The submission failed and the card is still open: the unsent edit is kept and saved. */
  resume(): void;
}

function newMountId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function useCardDraft(question: QuestionRef, draft: CardDraft, restore: (draft: CardDraft) => void): CardDraftHandle {
  const rpc = useLearningRpc();
  const callRef = useRef<Call>(rpc.call);
  callRef.current = rpc.call;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const { sessionId, ordinal } = question;
  const key = draftStorageKey(sessionId, ordinal);

  const state = useRef({
    mount: newMountId(),
    touched: false,
    stopped: false,
    /** The learner's latest edit on this card, and whether it still has to be handed to the queue. */
    latest: null as CardDraft | null,
    waiting: false,
    timer: null as ReturnType<typeof setTimeout> | null,
  }).current;

  const flush = useRef(() => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (!state.waiting || state.latest === null || state.stopped) return;
    state.waiting = false;
    enqueue(callRef.current, { sessionId, ordinal }, { mount: state.mount, draft: state.latest, base: baselines.get(key) ?? null });
  }).current;

  // On mount, after pruning old and excess backups: the server's draft first. This browser's backup wins
  // only if it was built on that very draft (its base is the server's token); otherwise the server moved
  // on (another device saved) and the backup goes. An edit made before the read returns beats both.
  useEffect(() => {
    let live = true;
    pruneBackups();
    const backup = readBackup(key);
    void sweepDrafts(callRef.current);
    callRef.current("cardDraft", { sessionId, ordinal })
      .then(({ draft: saved, token }) => {
        if (!live) return;
        baselines.set(key, token);
        if (state.touched || state.stopped) {
          // The learner's edit came first and now builds on what the server holds.
          const mine = readBackup(key);
          if (mine !== null && mine.mount === state.mount) writeBackup(key, { mount: mine.mount, draft: mine.draft, base: token });
          return;
        }
        if (backup !== null && backup.base === token) {
          restoreRef.current(backup.draft);
          enqueue(callRef.current, { sessionId, ordinal }, { mount: backup.mount, draft: backup.draft, base: backup.base });
          return;
        }
        if (backup !== null) removeBackupIf(key, backup);
        if (saved !== null) restoreRef.current(saved);
      })
      .catch((error: unknown) => {
        warn(`read the unsent answer to question ${ordinal}`, error);
        // The server cannot say: what this browser kept is shown, and kept, but not sent.
        if (live && backup !== null && !state.touched && !state.stopped) restoreRef.current(backup.draft);
      });
    return () => {
      live = false;
    };
  }, [key, sessionId, ordinal, state]);

  // Each edit is backed up at once and saved after the wait.
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (!state.touched || state.stopped) return;
    state.latest = JSON.parse(serialized) as CardDraft;
    state.waiting = true;
    writeBackup(key, { mount: state.mount, draft: state.latest, base: baselines.get(key) ?? null });
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
  }, [serialized, key, flush, state]);

  // Leaving the thread unmounts the card; hiding or unloading the page may end it. Save what is waiting.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, [flush]);

  return {
    edited: () => {
      state.touched = true;
    },
    flush,
    stop: () => {
      state.stopped = true;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      dropWaiting({ sessionId, ordinal });
      if (state.latest !== null) removeBackupIf(key, { mount: state.mount, draft: state.latest });
    },
    resume: () => {
      state.stopped = false;
      if (state.latest === null) return;
      writeBackup(key, { mount: state.mount, draft: state.latest, base: baselines.get(key) ?? null });
      state.waiting = true;
      flush();
    },
  };
}
