/**
 * The view each thread's Review tab was showing, picked in its dropdown (or Go to), so coming back to
 * the thread shows it again: bb mounts the tab anew each time its thread is opened. It is kept in this
 * browser, per thread, with the target the tab was opened on (`params`): a tab opened on another view
 * starts there instead. A view the user never picked (the first load's choice) is not kept, so the
 * tab picks again.
 */
import { targetRequestSchema, type TargetRequest } from "../shared/types";

const viewKey = (threadId: string) => `diff-review:view:${threadId}`;

/** Where the tab starts: `restored` when from a kept pick; `auto` lets the first load pick (no view asked for). */
export interface StartingView {
  target: TargetRequest;
  auto: boolean;
  restored: boolean;
}

/** The view `params` asks for, or null. */
export function paramsTarget(params: unknown): TargetRequest | null {
  const parsed = targetRequestSchema.safeParse((params as { target?: unknown } | null)?.target);
  return parsed.success ? parsed.data : null;
}

function read(threadId: string): { opened: TargetRequest | null; target: TargetRequest } | null {
  try {
    const raw = window.localStorage.getItem(viewKey(threadId));
    if (raw === null) return null;
    const value = JSON.parse(raw) as { opened?: unknown; target?: unknown };
    const target = targetRequestSchema.safeParse(value.target);
    const opened = value.opened === null ? null : targetRequestSchema.safeParse(value.opened);
    if (!target.success || (opened !== null && !opened.success)) return null;
    return { opened: opened === null ? null : opened.data, target: target.data };
  } catch {
    return null;
  }
}

/**
 * The view to start on: the one kept for `threadId` (null: keep none) when the tab is opened as it was
 * then; otherwise the one `params` asks for, or the uncommitted changes with the first load picking.
 */
export function startingView(params: unknown, threadId: string | null): StartingView {
  const asked = paramsTarget(params);
  const kept = threadId === null ? null : read(threadId);
  if (kept !== null && JSON.stringify(kept.opened) === JSON.stringify(asked)) return { target: kept.target, auto: false, restored: true };
  return asked === null ? { target: { kind: "uncommitted" }, auto: true, restored: false } : { target: asked, auto: false, restored: false };
}

/** Keeps the view the user picked in `threadId`'s tab, opened with `params`. */
export function keepView(threadId: string, params: unknown, target: TargetRequest): void {
  try {
    window.localStorage.setItem(viewKey(threadId), JSON.stringify({ opened: paramsTarget(params), target }));
  } catch {
    // A browser without storage just forgets the choice.
  }
}

/** Forgets `threadId`'s kept view (it is gone: its range, commit or pull request cannot be had). */
export function forgetView(threadId: string): void {
  try {
    window.localStorage.removeItem(viewKey(threadId));
  } catch {
    // Nothing kept.
  }
}
