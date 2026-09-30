/**
 * The pure half of the chat's expanding watch notes (`watch-note-expander.tsx`): which chips are watch
 * notes, and how a watch's plain-text output is shown through bb's Markdown.
 */
import { WATCH_NOTES_FOLDER, WATCH_NOTE_FILE } from "../shared/types";

/**
 * The attribute bb puts on every chip it draws in a message, holding the chip's resource as JSON. It is
 * bb's markup, not the SDK's contract: when it changes, the chips open the note file again, as a plain
 * path mention does.
 */
export const CHIP_RESOURCE_ATTRIBUTE = "data-prompt-mention-resource";

const PREFIX = `${WATCH_NOTES_FOLDER}/`;

/** The saved note's file name when the chip's resource is one of the plugin's watch notes; null otherwise. */
export function watchNoteFile(resource: string | null): string | null {
  if (resource === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resource);
  } catch {
    // Not ours to read; another chip's markup.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { kind, source, path } = parsed as Record<string, unknown>;
  if (kind !== "path" || source !== "workspace" || typeof path !== "string" || !path.startsWith(PREFIX)) return null;
  const file = path.slice(PREFIX.length);
  return WATCH_NOTE_FILE.test(file) ? file : null;
}

/**
 * A watch prints plain text, laid out by lines; Markdown would join them. Every line that runs on into
 * another gets a hard break, outside fenced code, so lists and links still render and the lines stay.
 */
export function keepLineBreaks(text: string): string {
  const lines = text.replace(/^\s*\n|\n\s*$/g, "").split("\n");
  let fenced = false;
  return lines
    .map((line, index) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      const next = lines[index + 1];
      return fenced || line.trim() === "" || next === undefined || next.trim() === "" || next.trimStart().startsWith("```") ? line : `${line}  `;
    })
    .join("\n");
}

/** The text as a fenced code block, its fence longer than any run of backticks inside it. */
export function codeBlock(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
