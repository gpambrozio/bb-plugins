/**
 * A skill's body renders through bb's own `Markdown`, which loads an image as
 * soon as it draws it and takes no say over that. A skill someone else wrote
 * can carry a remote image — a tracking pixel among them — and opening its
 * detail should fetch nothing.
 *
 * So the body is parsed the way bb's renderer parses it (mdast, with GFM) and
 * every node that could load something is defused in the source, by its
 * position: an image or image reference loses its `!` and becomes a link to
 * the same place, which loads only if followed; raw HTML has its `<` escaped,
 * so a tag shows as text. Defusing an image can expose one nested in its alt
 * text, so the body is parsed again until nothing is left to defuse.
 */
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Edit = { start: number; end: number; text: string };

export function parseBody(markdown: string): Nodes {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function collectEdits(node: Nodes, source: string, edits: Edit[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if ((node.type === "image" || node.type === "imageReference") && start !== undefined && source[start] === "!") {
    edits.push({ start, end: start + 1, text: "" });
  } else if (node.type === "html" && start !== undefined && end !== undefined && node.value.includes("<")) {
    edits.push({ start, end, text: source.slice(start, end).replaceAll("<", "&lt;") });
  }
  if ("children" in node) for (const child of node.children) collectEdits(child, source, edits);
}

export function withoutImages(markdown: string): string {
  let source = markdown;
  // Every pass removes at least one `!` or `<`, so this ends.
  for (;;) {
    const edits: Edit[] = [];
    collectEdits(parseBody(source), source, edits);
    if (edits.length === 0) return source;
    // Nodes nest, never overlap, and an image's `!` lies outside its children:
    // applied from the end, no edit moves another's offsets.
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
  }
}
