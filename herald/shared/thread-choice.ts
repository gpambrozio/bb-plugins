/**
 * What Herald announces for one thread, chosen from bb's thread menu: every
 * kind of event its settings announce, only the ones that wait on the user,
 * or nothing. The choice is stored in Herald's own plugin metadata on the
 * thread; a thread with none follows the nearest thread above it that has
 * one, and otherwise Herald's settings, as it always did.
 *
 * Both halves read this module — the server before it announces, the thread
 * menu to show the choice — so it imports nothing from the SDK.
 */
import { z } from "zod";

import type { AttentionReason } from "./herald";

export const THREAD_CHOICES = ["announce", "questions", "silent"] as const;
export type ThreadChoice = (typeof THREAD_CHOICES)[number];
export const ThreadChoiceSchema = z.enum(THREAD_CHOICES);

/** What the menu offers: one of the choices, or `default` to clear the thread's own. */
export const CHOICE_OPTIONS = ["default", ...THREAD_CHOICES] as const;
export type ChoiceOption = (typeof CHOICE_OPTIONS)[number];
export const ChoiceOptionSchema = z.enum(CHOICE_OPTIONS);

export const CHOICE_LABELS: Record<ChoiceOption, string> = {
  default: "Default",
  announce: "Announce",
  questions: "Questions only",
  silent: "Silent",
};

/** The key in Herald's thread plugin metadata; absent means the thread has no choice of its own. */
export const CHOICE_METADATA_KEY = "announce";

/** The server publishes here when a thread's choice changes, so every open thread menu re-reads. */
export const CHOICES_CHANNEL = "choices";

/** How many threads one `choices.list` call takes: bb's limit for a batched thread read. */
export const CHOICES_BATCH_MAX = 200;

/** The kinds of event that wait on the user. A finished or failed turn does not. */
const WAITING_REASONS: ReadonlySet<AttentionReason> = new Set(["question", "plan", "permission"]);

/** A thread's own choice from its Herald metadata, or null when it has none or it is unreadable. */
export function ownChoiceOf(metadata: unknown): ThreadChoice | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const parsed = ThreadChoiceSchema.safeParse((metadata as Record<string, unknown>)[CHOICE_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * What decides a thread's choice: its own, and the nearest thread above it
 * with one. `fromParent` says whether that is the thread that started this one.
 */
export const ChoiceInputsSchema = z.object({
  own: ThreadChoiceSchema.nullable(),
  inherited: z
    .object({ choice: ThreadChoiceSchema, threadId: z.string(), fromParent: z.boolean() })
    .nullable(),
});
export type ChoiceInputs = z.infer<typeof ChoiceInputsSchema>;

export const NO_CHOICE: ChoiceInputs = { own: null, inherited: null };

/**
 * Where a thread's effective choice comes from: its own; the parent's or a
 * thread further up; Herald's setting for threads another thread started
 * (off by default, which is silent); or the plain default, which announces.
 */
export type ChoiceSource = "self" | "parent" | "ancestor" | "subagent" | "default";

export interface EffectiveChoice {
  choice: ThreadChoice;
  source: ChoiceSource;
}

/**
 * A choice set on the thread itself wins, even over *Announce threads started
 * by another thread*: the user asked for this thread by name. Without one, a
 * thread another thread started stays quiet unless that setting is on, as
 * before; and otherwise the nearest choice above it applies, so a worker
 * follows its coordinator.
 */
export function effectiveChoice(inputs: ChoiceInputs, isChild: boolean, announceSubagents: boolean): EffectiveChoice {
  if (inputs.own !== null) return { choice: inputs.own, source: "self" };
  if (isChild && !announceSubagents) return { choice: "silent", source: "subagent" };
  if (inputs.inherited !== null) {
    return { choice: inputs.inherited.choice, source: inputs.inherited.fromParent ? "parent" : "ancestor" };
  }
  return { choice: "announce", source: "default" };
}

/** Whether a choice lets an event of this kind be spoken; Herald's per-kind switches still apply on top. */
export function choiceAllows(choice: ThreadChoice, reason: AttentionReason): boolean {
  switch (choice) {
    case "announce":
      return true;
    case "questions":
      return WAITING_REASONS.has(reason);
    case "silent":
      return false;
  }
}

/**
 * The own choices of a thread and its ancestors (parent first, root last)
 * folded into its inputs: the nearest ancestor with a choice is the one it
 * inherits.
 */
export function inputsFrom(threadId: string, ancestorIds: readonly string[], own: ReadonlyMap<string, ThreadChoice>): ChoiceInputs {
  let inherited: ChoiceInputs["inherited"] = null;
  for (const [index, ancestorId] of ancestorIds.entries()) {
    const choice = own.get(ancestorId);
    if (choice === undefined) continue;
    inherited = { choice, threadId: ancestorId, fromParent: index === 0 };
    break;
  }
  return { own: own.get(threadId) ?? null, inherited };
}
