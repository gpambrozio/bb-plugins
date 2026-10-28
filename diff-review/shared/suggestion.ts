/**
 * GitHub-style suggested changes: a ```suggestion block in a comment holds the replacement for the
 * thread's lines. Adapted from diffity's `src/features/suggestions/suggestion.ts`
 * (https://github.com/nilbuild/diffity, MIT).
 */

export type SuggestionState = "ready" | "applied" | "outdated" | "unknown";

export interface SuggestionLine {
  kind: "context" | "del" | "add";
  text: string;
}

function lines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized === "" ? [] : normalized.split("\n");
}

export function sameCode(a: string, b: string): boolean {
  return lines(a).join("\n") === lines(b).join("\n");
}

/**
 * The lines a suggestion block puts in place of the thread's, from the text between its fences as
 * written (`BodyPart`'s `code`): an empty block removes the lines, and every line inside the fences
 * counts, a blank last one included.
 */
export function suggestedLines(code: string): string[] {
  const normalized = code.replace(/\r\n/g, "\n");
  return normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
}

/** The lines of a thread's lines as text (each line, joined with "\n"), a blank last line included. */
function textLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Whether `code` can still be applied over the thread's lines: `current` is what they read now
 * (undefined when the diff does not show them), `anchor` what they read when commented on.
 */
export function suggestionState(code: string, current: string | undefined, anchor: string | null): SuggestionState {
  if (current === undefined) return "unknown";
  const suggested = suggestedLines(code);
  const now = textLines(current);
  if (now.length === suggested.length && now.every((line, index) => line === suggested[index])) return "applied";
  if (anchor !== null && !sameCode(anchor, current)) return "outdated";
  return "ready";
}

/** Old against suggested lines, with the unchanged lines at either end kept as context. */
export function suggestionLines(original: string, code: string): SuggestionLine[] {
  const before = textLines(original);
  const after = suggestedLines(code);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const from = (source: string[], kind: SuggestionLine["kind"], start: number, end: number) => source.slice(start, end).map((text) => ({ kind, text }));
  return [
    ...from(before, "context", 0, head),
    ...from(before, "del", head, before.length - tail),
    ...from(after, "add", head, after.length - tail),
    ...from(before, "context", before.length - tail, before.length),
  ];
}

/** `body` with a suggestion block seeded with `code` added on lines of its own at `cursor`. */
export function insertSuggestion(body: string, cursor: number, code: string): { body: string; cursor: number } {
  const before = body.slice(0, cursor);
  const after = body.slice(cursor);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const open = `${lead}\`\`\`suggestion\n`;
  const block = `${open}${code.replace(/\n$/, "")}\n\`\`\`${trail}`;
  return { body: `${before}${block}${after}`, cursor: before.length + open.length };
}

const SUGGESTION_BLOCK = /^```suggestion[^\n]*\n([\s\S]*?)^```[^\n]*$/gm;

/**
 * A comment body as Markdown text and suggestion blocks, in order. A block's `code` is the text
 * between its fences as written, ending with the newline before the closing fence unless empty; read
 * its lines with `suggestedLines`.
 */
export type BodyPart = { kind: "text"; text: string } | { kind: "suggestion"; code: string };

export function bodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(SUGGESTION_BLOCK)) {
    const text = body.slice(last, match.index);
    if (text.trim() !== "") parts.push({ kind: "text", text });
    parts.push({ kind: "suggestion", code: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim() !== "" || parts.length === 0) parts.push({ kind: "text", text: rest });
  return parts;
}

/** A file's lines, each with the line ending it has ("" for a last line without one). */
export function splitLines(content: string): { text: string; eol: string }[] {
  const parts: { text: string; eol: string }[] = [];
  const pattern = /\r?\n/g;
  let from = 0;
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    parts.push({ text: content.slice(from, match.index), eol: match[0] });
    from = match.index + match[0].length;
  }
  if (from < content.length) parts.push({ text: content.slice(from), eol: "" });
  return parts;
}

export function joinLines(lines: readonly { text: string; eol: string }[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/**
 * `content` with lines `start`..`end` (1-based) replaced by `code`, or null when those lines no
 * longer read `expected` (the file changed since the view was loaded). The new lines take the ending
 * of the last line they replace, and every other line keeps its own.
 */
export function replaceLines(content: string, start: number, end: number, expected: string, code: string): string | null {
  const all = splitLines(content);
  if (start < 1 || end < start || end > all.length) return null;
  if (!sameCode(all.slice(start - 1, end).map((line) => line.text).join("\n"), expected)) return null;
  const replaced = all.slice(start - 1, end);
  const eol = replaced.find((line) => line.eol !== "")?.eol ?? "\n";
  const last = replaced[replaced.length - 1]!.eol;
  const added = suggestedLines(code).map((text, index, list) => ({ text, eol: index === list.length - 1 ? last : eol }));
  return joinLines([...all.slice(0, start - 1), ...added, ...all.slice(end)]);
}
