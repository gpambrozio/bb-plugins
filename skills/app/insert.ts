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
 * it, unchanged.
 */
export function withCommand(draft: string, command: string): string {
  const rest = draft.trimStart();
  return rest.length === 0 ? command : `${command}${rest}`;
}

/**
 * Whether the composer a component writes to is this thread's own — its draft,
 * or one of its queued messages being edited. Anywhere else (a side chat, the
 * new-thread composer) a command for this thread does not belong.
 */
export function writesToThread(scope: { kind: string; threadId?: string }, threadId: string): boolean {
  return (scope.kind === "thread" || scope.kind === "queued-message") && scope.threadId === threadId;
}
