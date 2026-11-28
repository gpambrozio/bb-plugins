/**
 * The staged instructions edit as the app shows it, apart from React so it is tested plainly: the sidebar
 * badge's pencil, and the notes around the diff.
 */
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";

import type { StagedEdit } from "../shared/prompt-edit";

/** The pencil the sidebar entry wears while an edit waits: the SDK's badge takes text, not an icon. */
export const PENCIL = "✎";
export const WAITING_LABEL = "An edit of Voice Pilot's instructions waits for your review";

/** The sidebar badge: the session's (Live, Paused…) with the pencil after it while an edit waits. */
export function withPencil(voice: ExperimentalBadge | null, waiting: boolean): ExperimentalBadge | null {
  if (!waiting) return voice;
  if (voice === null) return { text: PENCIL, tone: "warning", label: WAITING_LABEL };
  return { ...voice, text: `${voice.text ?? ""} ${PENCIL}`.trim().slice(0, 8), label: `${voice.label}. ${WAITING_LABEL}` };
}

/** "3:04 PM", or the date too when it was not today. */
export function stagedWhen(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

/** The notes above the diff: what this edit replaced, and whether the instructions moved since it was made. */
export function stagedNotes(staged: StagedEdit, current: string, now: number = Date.now()): string[] {
  const notes: string[] = [];
  if (staged.replaced !== null) {
    notes.push(`This replaced the edit proposed at ${stagedWhen(staged.replaced.stagedAt, now)} (“${staged.replaced.summary}”), which was dropped: one edit waits at a time.`);
  }
  if (staged.base !== current) {
    notes.push("The instructions changed since this was proposed. The diff is against the instructions now; applying replaces them with the proposed text.");
  }
  return notes;
}

export const NEXT_SESSION_NOTE = "An applied edit takes effect from the next voice session. A session in progress keeps the instructions it started with.";
