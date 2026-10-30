/**
 * Herald's sentences as push notifications, in place of bb's own for the
 * threads Herald announces. bb's push-notifications plugin decides what it
 * sends by a per-thread level; Herald sets that level to *muted* on a thread
 * it takes over and sends, through the same plugin's `notifications.send`,
 * exactly the notifications that mute took away — with Herald's sentence.
 *
 * The level rule below is a copy of bb's (`plugins/push-notifications/preferences.ts`
 * in bb 0.48.1), since its contract is not published as a package. Both
 * halves read this module, so it imports nothing from the SDK.
 */
import { z } from "zod";

import type { AttentionReason } from "./herald";

/** The plugin that owns bb's notifications, and the methods Herald calls on it. */
export const PUSH_PLUGIN_ID = "push-notifications";
export const PUSH_SEND_METHOD = "notifications.send";
export const PUSH_LEVELS_LIST_METHOD = "threadNotifications.list";
export const PUSH_LEVEL_SET_METHOD = "threadNotifications.set";

/** bb cuts a sent title and body at these; Herald cuts first, at a word, so the cut reads well. */
export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 180;

export const NOTIFICATION_LEVELS = ["all", "input-only", "muted"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];
export const NotificationLevelSchema = z.enum(NOTIFICATION_LEVELS);

/** A thread's own level; `inherit` is no level of its own. */
export const OWN_LEVELS = ["inherit", ...NOTIFICATION_LEVELS] as const;
export type OwnLevel = (typeof OWN_LEVELS)[number];
export const OwnLevelSchema = z.enum(OWN_LEVELS);

/** bb's push-notifications settings that decide a thread without a level of its own. */
export interface LevelDefaults {
  defaultLevel: NotificationLevel;
  childLevel: OwnLevel;
}

/** bb 0.48.1's own defaults, used when its settings cannot be read. */
export const BB_LEVEL_DEFAULTS: LevelDefaults = { defaultLevel: "all", childLevel: "input-only" };

/** What bb notifies about: an interaction waiting, a failed turn, a finished turn. */
export type PushKind = "pending-interaction" | "thread-error" | "turn-finished";

const KINDS_BY_LEVEL: Record<NotificationLevel, ReadonlySet<PushKind>> = {
  all: new Set(["pending-interaction", "thread-error", "turn-finished"]),
  "input-only": new Set(["pending-interaction", "thread-error"]),
  muted: new Set(),
};

const LEVEL_RANK: Record<NotificationLevel, number> = { muted: 0, "input-only": 1, all: 2 };

export function pushKindOf(reason: AttentionReason): PushKind {
  switch (reason) {
    case "question":
    case "plan":
    case "permission":
      return "pending-interaction";
    case "finished":
      return "turn-finished";
    case "error":
      return "thread-error";
  }
}

export function levelAllows(level: NotificationLevel, reason: AttentionReason): boolean {
  return KINDS_BY_LEVEL[level].has(pushKindOf(reason));
}

/**
 * bb's rule for the level a thread notifies at: its own level, else the
 * child-thread default for a thread another started, else the default; and
 * every ancestor's own level caps it. `ownOf` gives each thread's own level.
 */
export function resolveLevel(
  threadId: string,
  ancestorIds: readonly string[],
  ownOf: (threadId: string) => OwnLevel,
  defaults: LevelDefaults,
): NotificationLevel {
  const own = ownOf(threadId);
  let level: NotificationLevel =
    own !== "inherit"
      ? own
      : ancestorIds.length > 0 && defaults.childLevel !== "inherit"
        ? defaults.childLevel
        : defaults.defaultLevel;
  for (const ancestorId of ancestorIds) {
    const cap = ownOf(ancestorId);
    if (cap !== "inherit" && LEVEL_RANK[cap] < LEVEL_RANK[level]) level = cap;
  }
  return level;
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const head = line.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  // At a word when one ends in the last third; a long word is cut where it is.
  return `${(space > max * 0.66 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The thread's name, as bb's own notification titles it, and its project
 * after it when both fit: a phone's lock screen shows little else.
 */
export function pushTitle(threadTitle: string | null, projectName: string | null): string {
  const thread = threadTitle?.trim() || null;
  const project = projectName?.trim() || null;
  if (thread === null) return cut(project ?? "Herald", PUSH_TITLE_MAX);
  if (project === null || project === thread) return cut(thread, PUSH_TITLE_MAX);
  const both = `${thread} · ${project}`;
  return both.length <= PUSH_TITLE_MAX ? both : cut(thread, PUSH_TITLE_MAX);
}

/** Herald's sentence, on one line, cut to what bb sends. */
export function pushBody(sentence: string): string {
  return cut(sentence, PUSH_BODY_MAX);
}

/**
 * What the Herald page says about the switch: off; on and sending; unable to
 * start (an older bb, or bb's Push notifications plugin off), with bb's own
 * notifications left as they were; or stopped after a send failed, with the
 * levels Herald had changed put back.
 */
export const PUSH_STATES = ["off", "on", "unavailable", "failed"] as const;
export const PushStatusSchema = z.object({
  state: z.enum(PUSH_STATES),
  message: z.string().nullable(),
});
export type PushStatus = z.infer<typeof PushStatusSchema>;
