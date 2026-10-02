/**
 * **Add to chat**: what a skill puts in the thread's message box. The plugin
 * never sends anything; the user finishes the message and sends it.
 */

/** The skill's command and a space to go on typing after. */
export function chatText(name: string): string {
  return `/${name} `;
}

/**
 * The draft with `command` in it. A slash command runs only at the start of a
 * message, so the command goes first and whatever the user had typed follows
 * it, unchanged. Its mention pills move with the text they sit in: the host
 * takes their ranges as given and does not rebase them.
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
