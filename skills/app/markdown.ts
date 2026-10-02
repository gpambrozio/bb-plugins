/**
 * A skill's body renders through bb's own `Markdown`, which loads an image as
 * soon as it draws it and takes no say over that. A skill someone else wrote
 * can carry a remote image or raw HTML, and opening its detail should fetch
 * nothing — and never hang or crash the surface, whatever the body holds.
 *
 * Deliberately conservative rather than precise:
 *
 * - **Budgets first.** The parser (the one bb's renderer uses too) slows down
 *   badly on some shapes — nested image labels, long runs of mixed emphasis
 *   delimiters, very large bodies — and throws on very deep nesting. A body
 *   past any budget below is never parsed: it is shown whole as a fenced code
 *   block, which loads nothing and which bb parses in linear time. The counts
 *   are raw character counts, so no syntax (a code span, an escape) can hide
 *   anything from them. Real skills sit far below every one.
 * - **One parse, one walk.** Every image, image reference and HTML node, at
 *   any depth, is replaced in the source by its position with literal text:
 *   every ASCII punctuation mark escaped and line breaks folded, so nothing in
 *   it is syntax. An image becomes its alt text alone, wrapped in escaped
 *   brackets, so it is never empty and its ends never combine with a
 *   neighbouring `!`, `[` or `(` into new syntax. Its source is left out: a
 *   reference image would copy its definition's URL into every use, and the
 *   body could grow far past what was measured. Every replacement comes from
 *   the replaced span itself, so the output is at most twice the input.
 * - **Any throw** shows the body as the same fenced block.
 */
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Real skills are tens of kilobytes (9 of 1,398 measured are larger); within
 * this, every hostile shape tried parses in a few hundred milliseconds.
 */
export const MAX_PARSED_LENGTH = 48 * 1024;
/** Every link and image opens with one; nested image labels are the parser's worst case. */
export const MAX_OPEN_BRACKETS = 512;
/** Emphasis delimiters; long mixed runs of them cost the parser quadratic time. */
export const MAX_EMPHASIS_DELIMITERS = 4096;
/** Blockquote and list markers opening one line; thousands of them overflow the stack. */
export const MAX_LINE_CONTAINERS = 32;

const CONTAINER_MARKER = /^[ \t]*(?:>|[*+-](?=[ \t])|\d{1,9}[.)](?=[ \t]))/;

function count(text: string, characters: string): number {
  let total = 0;
  for (const character of text) if (characters.includes(character)) total += 1;
  return total;
}

/** The most blockquote and list markers any one line opens with. */
function deepestLine(text: string): number {
  let deepest = 0;
  for (let line of text.split("\n")) {
    let markers = 0;
    for (let match = CONTAINER_MARKER.exec(line); match !== null; match = CONTAINER_MARKER.exec(line)) {
      markers += 1;
      if (markers > MAX_LINE_CONTAINERS) return markers;
      line = line.slice(match[0].length);
    }
    deepest = Math.max(deepest, markers);
  }
  return deepest;
}

/** Whether a body is within every budget, so it may be parsed at all. */
export function withinBudgets(markdown: string): boolean {
  return (
    markdown.length <= MAX_PARSED_LENGTH &&
    count(markdown, "[") <= MAX_OPEN_BRACKETS &&
    count(markdown, "*_") <= MAX_EMPHASIS_DELIMITERS &&
    deepestLine(markdown) <= MAX_LINE_CONTAINERS
  );
}

export function parseBody(markdown: string): Nodes {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** The whole body as one fenced code block, fenced longer than any backtick run in it. */
export function asCodeBlock(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** One run of literal text: line breaks folded, every ASCII punctuation mark escaped. */
export function asText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

function imageText(alt: string | null | undefined): string {
  return `\\[${asText(alt ?? "")}\\]`;
}

type Edit = { start: number; end: number; text: string };

function defuse(markdown: string, parse: (markdown: string) => Nodes): string {
  const edits: Edit[] = [];

  function walk(node: Nodes): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "image" || node.type === "imageReference") edits.push({ start, end, text: imageText(node.alt) });
      else if (node.type === "html") edits.push({ start, end, text: asText(node.value) });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  }
  walk(parse(markdown));

  // Images and HTML have no children here and never overlap one another, so
  // the output is the source between them and their replacements, in order.
  const parts: string[] = [];
  let position = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    parts.push(markdown.slice(position, edit.start), edit.text);
    position = edit.end;
  }
  parts.push(markdown.slice(position));
  return parts.join("");
}

/**
 * The body, safe to hand to bb's `Markdown`. `parse` is for tests that need
 * the parser to fail.
 */
export function withoutImages(markdown: string, parse: (markdown: string) => Nodes = parseBody): string {
  if (!withinBudgets(markdown)) return asCodeBlock(markdown);
  try {
    return defuse(markdown, parse);
  } catch {
    return asCodeBlock(markdown);
  }
}
