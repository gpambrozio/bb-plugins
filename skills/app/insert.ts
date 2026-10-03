/**
 * **Add to chat**: what a skill puts in the thread's message box. The plugin
 * never sends anything; the user finishes the message and sends it.
 */
import type { ComposerDraftReplacement, ComposerMention } from "@get-bb/plugin-sdk/app";

import type { SkillSourceKind } from "../shared/skills";

/**
 * Everything bb needs to draw a skill or command as the pill its own `/` menu
 * inserts (`{ kind: "command" }` in `ComposerMention`), less the range.
 */
export interface SkillCommand {
  name: string;
  source: "command" | "skill";
  origin: "builtin" | "project" | "user";
  argumentHint: string | null;
}

/**
 * The command for a skill discovery found, of source kind `kind` (unknown
 * while the list is loading). bb's own list calls a skill `project` when it
 * comes from the workspace and `user` otherwise, and has no argument hint for a
 * skill read from disk; this does the same.
 */
export function discoveredCommand(name: string, kind: SkillSourceKind | undefined): SkillCommand {
  const fromWorkspace = kind === "project" || kind === "repo";
  return { name, source: "skill", origin: fromWorkspace ? "project" : "user", argumentHint: null };
}

/** The command for an entry bb's provider reported, as that list described it. */
export function reportedCommand(
  entry: { name: string; argumentHint: string; origin: SkillCommand["origin"] },
  source: SkillCommand["source"],
): SkillCommand {
  return { name: entry.name, source, origin: entry.origin, argumentHint: entry.argumentHint || null };
}

/** The command as text, and a space to go on typing after. */
export function chatText(name: string): string {
  return `/${name} `;
}

/**
 * Whether a name can be a pill. A pill stands for `/name` in the message, so a
 * name with whitespace in it would come apart into a command and arguments;
 * such a name goes in as text instead, which is what the user would type.
 */
export function canBePill(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

type Draft = { text: string; mentions: readonly ComposerMention[] };

/**
 * The draft with `command` first, as the pill bb's own `/` menu inserts. A
 * slash command runs only at the start of a message, so it goes first and
 * whatever the user had typed follows it. A command pill already at the start
 * is replaced rather than joined by a second one, as bb's Plan and Goal rows
 * do. The other pills move with the text they sit in: the host takes their
 * ranges as given and does not rebase them.
 */
export function withSkillCommand(draft: Draft, command: SkillCommand): ComposerDraftReplacement {
  if (!canBePill(command.name)) return withCommand(draft, chatText(command.name));
  const leading = draft.mentions.find((mention) => mention.kind === "command" && mention.from === 0);
  const pillText = `/${command.name}`;
  const rest = draft.text.slice(leading?.to ?? 0).trimStart();
  const prefix = `${pillText} `;
  const shift = prefix.length - (draft.text.length - rest.length);
  const pill: ComposerMention = { kind: "command", trigger: "/", from: 0, to: pillText.length, label: command.name, ...command };
  return {
    text: `${prefix}${rest}`,
    mentions: [
      pill,
      ...draft.mentions
        .filter((mention) => mention !== leading)
        .map((mention) => ({ ...mention, from: mention.from + shift, to: mention.to + shift })),
    ],
  };
}

/**
 * The draft with `command` put first as plain text — the fallback for a name
 * that cannot be a pill. Mention pills move with the text they sit in.
 */
export function withCommand<Mention extends { from: number; to: number }>(
  draft: { text: string; mentions: readonly Mention[] },
  command: string,
): { text: string; mentions: Mention[] } {
  const rest = draft.text.trimStart();
  const shift = command.length - (draft.text.length - rest.length);
  return {
    text: rest.length === 0 ? command : `${command}${rest}`,
    mentions: draft.mentions.map((mention) => ({ ...mention, from: mention.from + shift, to: mention.to + shift })),
  };
}

/**
 * Whether the composer a component writes to is this thread's own — its draft,
 * or one of its queued messages being edited. Anywhere else (a side chat, the
 * new-thread composer) a command for this thread does not belong.
 */
export function writesToThread(scope: { kind: string; threadId?: string }, threadId: string): boolean {
  return (scope.kind === "thread" || scope.kind === "queued-message") && scope.threadId === threadId;
}
