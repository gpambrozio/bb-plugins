/**
 * A skill's body renders through bb's own `Markdown`, which loads an image as
 * soon as it draws it and takes no say over that. A skill someone else wrote
 * can carry a remote image — a tracking pixel among them — and opening its
 * detail should fetch nothing.
 *
 * So the body is parsed once, the way bb's renderer parses it (mdast, with
 * GFM), and each node that could load something is replaced in the source, by
 * its position, in one pass:
 *
 * - an image or image reference becomes plain text: its alt text, then its
 *   source in parentheses, both escaped. An image nested in another's alt
 *   text is part of that alt string, not a node, so it becomes text with it.
 *   Nothing here emits a `[`, so no replacement can form a new image with a
 *   `!` that precedes it.
 * - raw HTML has its `<` escaped, so a tag shows as text.
 *
 * One parse and one walk, whatever the nesting: a body is drawn as the user
 * opens it, so this must not grow with how deeply images nest. The parser
 * itself does: nested image labels cost it time quadratic in their depth
 * (4,096 levels, 16 KB, take it seconds) — bb's own renderer, the same
 * parser, as much. So a body nested deeper than any real skill, or larger
 * than any, is never parsed: a linear scan sends it to a code block, which
 * shows it as text and loads nothing, and which bb's renderer parses in
 * linear time too.
 */
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Edit = { start: number; end: number; text: string };

/** Deeper bracket nesting than this is no real skill; it is shown as text unparsed. */
export const MAX_BRACKET_DEPTH = 32;
/** Real skills run to tens of kilobytes; a larger body is shown as text unparsed. */
export const MAX_PARSED_LENGTH = 256 * 1024;

/** How deeply `[` nests, unescaped, in one linear pass. */
function bracketDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "[") deepest = Math.max(deepest, (depth += 1));
    else if (character === "]" && depth > 0) depth -= 1;
  }
  return deepest;
}

/** The whole body as one fenced code block, fenced longer than any backtick run in it. */
export function asCodeBlock(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function parseBody(markdown: string): Nodes {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * Backslash-escapes what Markdown could read as syntax, and folds line breaks,
 * so the result is one run of literal text. `:`, `/`, `.` and `-` stay as they
 * are, so a source URL can still show as a link — which loads only if followed.
 */
export function asText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/[\\`*_{}[\]()<>#+!|~&]/g, "\\$&");
}

function imageText(alt: string | null | undefined, url: string | undefined): string {
  const label = asText(alt ?? "");
  return url === undefined || url === "" ? label : `${label} (${asText(url)})`;
}

export function withoutImages(markdown: string): string {
  if (markdown.length > MAX_PARSED_LENGTH || bracketDepth(markdown) > MAX_BRACKET_DEPTH) {
    return asCodeBlock(markdown);
  }
  const tree = parseBody(markdown);
  const definitions = new Map<string, string>();
  const images: Array<{ start: number; end: number; alt: string | null | undefined; url?: string; ref?: string }> = [];
  const edits: Edit[] = [];

  function walk(node: Nodes): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "definition") {
      definitions.set(node.identifier, node.url);
    } else if (start !== undefined && end !== undefined) {
      if (node.type === "image") images.push({ start, end, alt: node.alt, url: node.url });
      else if (node.type === "imageReference") images.push({ start, end, alt: node.alt, ref: node.identifier });
      else if (node.type === "html") edits.push({ start, end, text: node.value.replaceAll("<", "&lt;") });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  }
  walk(tree);

  for (const image of images) {
    const url = image.ref === undefined ? image.url : definitions.get(image.ref);
    edits.push({ start: image.start, end: image.end, text: imageText(image.alt, url) });
  }

  // Nodes nest but never overlap, and images and HTML have no children here:
  // applied from the end, no edit moves another's offsets.
  let source = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}
