/**
 * What FirstMate's own notification for a finished first-mate turn says (`mate-notify.ts`), and the one
 * reply it says nothing for. Plain text: bb's notifications show no markdown.
 */

/** bb's push plugin cuts a title to 80 characters and a body to 180; cut here first, the same way. */
export const TITLE_LIMIT = 80;
export const BODY_LIMIT = 180;

/**
 * The charter's no-op reply (§9): exactly `Captain, shipshape.`. Case, spacing, the comma and the closing
 * punctuation may differ; any other word makes it a real message.
 */
const NO_OP_REPLY = /^captain,?\s+shipshape\s*[.!…]*$/iu;

/** Whether the first mate's reply is the charter's no-op, which tells the captain nothing new. */
export function isNoOpReply(text: string): boolean {
  return NO_OP_REPLY.test(text.trim());
}

export interface NotificationText {
  title: string;
  body: string;
}

/** A thread mention as bb writes it, `@thread:<id>` with an optional `#msg=<seq>`. */
const THREAD_MENTION = /@thread:([A-Za-z0-9_-]+)(?:#msg=\d+)?/gu;
const FENCE = /^\s*(```|~~~)/u;
/** A line that carries no words: a horizontal rule, a table row, a bb directive. */
const NO_WORDS = /^\s{0,3}(?:([-*_])(?:\s*\1){2,}\s*$|\||::[A-Za-z])/u;
/** Heading, quote and list markers at the start of a line. */
const LINE_MARKERS = /^\s{0,3}(?:#{1,6}\s+|(?:>\s?)+|[-*+]\s+|\d+[.)]\s+)/u;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** Links and images to their text, and code, emphasis and escapes to the words inside them. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/~~(.+?)~~/gu, "$1")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/gu, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, "$1");
}

/** The reply's lines that carry words, markdown stripped, code blocks left out. */
function meaningfulLines(text: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/u)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || NO_WORDS.test(raw)) continue;
    const line = stripInlineMarkdown(raw.replace(LINE_MARKERS, "")).replace(/\s+/gu, " ").trim();
    if (line !== "") lines.push(line);
  }
  return lines;
}

/**
 * The notification for the first mate's reply: its first line with words as the title, the rest joined
 * as the body, each cut to bb's limits. A thread mention reads as that thread's title in quotes, as in
 * bb's own notifications (`titleOf` answers null for a thread it cannot name). Null when the reply is the
 * no-op or has no words at all.
 */
export async function mateNotificationText(
  text: string,
  titleOf: (threadId: string) => Promise<string | null>,
): Promise<NotificationText | null> {
  if (isNoOpReply(text)) return null;
  const lines = meaningfulLines(text);
  if (lines.length === 0) return null;
  const joined = lines.join("\n");
  const ids = new Set([...joined.matchAll(THREAD_MENTION)].map((match) => match[1] as string));
  const titles = new Map(await Promise.all([...ids].map(async (id) => [id, await titleOf(id).catch(() => null)] as const)));
  const named = joined.replace(THREAD_MENTION, (mention, id: string) => {
    const title = titles.get(id);
    return title ? `“${truncate(title, 40)}”` : mention;
  });
  const [title = "", ...rest] = named.split("\n");
  return { title: truncate(title, TITLE_LIMIT), body: truncate(rest.join(" "), BODY_LIMIT) };
}
