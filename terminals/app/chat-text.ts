/**
 * What "Add to chat" puts in a composer: the selected terminal text as a
 * fenced block, under a line that says which tab and machine it came from.
 * No React and no SDK, so the tests can run it as it is.
 */

/** Where a selection came from, as the tab strip names it. */
export interface SelectionSource {
  /** The tab's title as the strip shows it: the user's name, or the machine and number. */
  tabLabel: string;
  hostName: string;
}

/**
 * The selection as a draft gets it: line endings made `\n`, trailing spaces
 * xterm pads lines with dropped, and blank lines at either end trimmed. The
 * text inside is kept exactly, indentation included. Empty when nothing is
 * left.
 */
export function normalizeSelection(text: string): string {
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** A fence longer than any run of backticks in `text`, so the block cannot end early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The block for `text`, or null when the selection is only whitespace. The
 * header names the tab and the machine; when the tab's title already is the
 * machine's name ("Mac mini", "Mac mini 2") the machine is not said twice.
 */
export function terminalBlock(text: string, source: SelectionSource): string | null {
  const body = normalizeSelection(text);
  if (body === "") return null;
  const fence = fenceFor(body);
  const header = source.tabLabel.startsWith(source.hostName)
    ? `Terminal output from ${source.tabLabel}:`
    : `Terminal output from ${source.tabLabel} on ${source.hostName}:`;
  return `${header}\n\n${fence}text\n${body}\n${fence}`;
}

/** The parts of a composer draft this file reads and writes. */
export interface DraftText {
  text: string;
  mentions: readonly { from: number; to: number }[];
}

/**
 * The draft with `block` added at its end, as bb's own "Add to chat" adds a
 * quote: the user's text, mentions and attachments stay as they were, the
 * block follows after a blank line, and the draft ends with a newline so the
 * user can type on below it.
 */
export function appendToDraft<Draft extends DraftText>(draft: Draft, block: string): Draft {
  if (draft.text.trim() === "" && draft.mentions.length === 0) return { ...draft, text: `${block}\n` };
  // Only newlines are trimmed from the end, so no mention range can lose a character.
  const before = draft.text.replace(/\n+$/, "");
  return { ...draft, text: `${before}\n\n${block}\n` };
}
