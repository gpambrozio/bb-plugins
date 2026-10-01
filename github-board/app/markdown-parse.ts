/**
 * The Markdown an issue body is written in, parsed into blocks and inline
 * tokens. Rendering is `app/markdown.tsx`; this half is pure so it can be
 * tested.
 *
 * It covers what an issue or pull request body actually uses — headings,
 * lists, task lists, fenced code, quotes, rules, collapsible details, pipe
 * tables, images on their own line, and bold, inline code and links — and
 * leaves the rest as text. HTML is rewritten into its Markdown spelling first
 * (`app/html.ts`), because a bot's body — Dependabot's, most of all — is
 * written in it.
 *
 * bb's own `Markdown` component is not used for bodies on purpose: it takes
 * only `content` and `className`, so it gives no say over how images load — and
 * an image from outside GitHub must wait for a tap (`app/image-gate.ts`), while
 * one on GitHub must come through the server with the token. Here every image is either a block the panel
 * renders through that gate or a link.
 *
 * Single newlines break lines, the way GitHub renders an issue body.
 */
import { htmlToMarkdown } from "./html";

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: ListItem[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "rule" }
  | { kind: "details"; summary: string; open: boolean; blocks: Block[] }
  | { kind: "image"; alt: string; url: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/**
 * `<details>` on a line of its own, as `htmlToMarkdown` leaves it. The
 * attributes survive because `open` decides whether it starts expanded.
 */
const DETAILS_OPEN = /^\s*<details\b([^>]*)>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const SUMMARY_LINE = /^\s*<summary>([\s\S]*?)<\/summary>\s*$/i;
/**
 * A link reference definition, `[label]: url`. GitHub shows none of them, and
 * `[//]: # (comment)` is the idiom bots use for a comment.
 */
const REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:\s+\S/;

export interface ListItem {
  marker: string;
  /** Nesting depth from the item's indentation, two spaces per level. */
  depth: number;
  text: string;
}

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
/**
 * A line that is one image and nothing else, in either spelling GitHub
 * accepts: Markdown, or the `<img>` tag its editor pastes for a resized one.
 * Only a whole line becomes an image block; an image inside a sentence stays
 * a link, so every image the panel draws goes through the one gated renderer.
 */
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const IMG_TAG_LINE = /^\s*<img\b([^>]*)>\s*$/i;

/**
 * A pipe table, GitHub's only table syntax: a header row, a `|---|` line, then
 * rows. Cells are split on unescaped pipes; a cell may be any inline text, or
 * an image, which is what most tables in a review thread are for.
 */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

export function imageOf(line: string): { alt: string; url: string } | null {
  const markdown = IMAGE_LINE.exec(line);
  if (markdown !== null) return { alt: markdown[1] ?? "", url: markdown[2] ?? "" };
  const tag = IMG_TAG_LINE.exec(line);
  if (tag === null) return null;
  const attributes = tag[1] ?? "";
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes);
  if (src === null) return null;
  const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attributes);
  return { alt: alt?.[1] ?? "", url: src[1] ?? "" };
}
const TASK_PREFIX = /^\[([ xX])\]\s+/;

function listItemOf(line: string): ListItem | null {
  const match = LIST_LINE.exec(line);
  if (match === null) return null;
  const indent = match[1] ?? "";
  const marker = match[2] ?? "-";
  let text = match[3] ?? "";
  let glyph = /^\d/.test(marker) ? marker.replace(")", ".") : "•";
  const task = TASK_PREFIX.exec(text);
  if (task !== null) {
    glyph = task[1] === " " ? "☐" : "☑";
    text = text.slice(task[0].length);
  }
  return { marker: glyph, depth: Math.floor(indent.replace(/\t/g, "  ").length / 2), text };
}

/**
 * Splits the source into blocks. HTML comments go first — they are how issue
 * templates carry their instructions, and GitHub does not show them either —
 * then the HTML that remains is rewritten as Markdown.
 */
export function parseMarkdown(source: string): Block[] {
  const markdown = htmlToMarkdown(
    source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, ""),
  );
  return parseBlocks(markdown.split("\n").filter((line) => !REFERENCE_DEFINITION.test(line)));
}

/**
 * Everything is decided line by line: a fence opens a code block that runs to
 * the next fence, `<details>` opens a block that runs to its `</details>`, a
 * blank line ends whatever else is open, and any line that is not a heading,
 * list item, quote or rule is paragraph text. Quotes and details hold blocks
 * of their own, parsed by the same rules.
 */
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: ListItem[] = [];
  let quote: string[] = [];

  function flush(): void {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list });
      list = [];
    }
    if (quote.length > 0) {
      blocks.push({ kind: "quote", blocks: parseBlocks(quote) });
      quote = [];
    }
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      flush();
      const code: string[] = [];
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1] ?? "```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // the closing fence, if there was one
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const details = DETAILS_OPEN.exec(line);
    if (details !== null) {
      flush();
      // Runs to the `</details>` that matches this one, past any nested pair.
      const body: string[] = [];
      let depth = 1;
      while (index < lines.length && depth > 0) {
        const inner = lines[index] ?? "";
        index += 1;
        if (DETAILS_OPEN.test(inner)) depth += 1;
        else if (DETAILS_CLOSE.test(inner)) depth -= 1;
        if (depth > 0) body.push(inner);
      }
      const first = body.findIndex((inner) => inner.trim() !== "");
      const summary = first === -1 ? null : SUMMARY_LINE.exec(body[first] ?? "");
      if (summary !== null) body.splice(first, 1);
      blocks.push({
        kind: "details",
        // "Details" is what a browser shows for a <details> with no summary.
        summary: summary?.[1]?.trim() || "Details",
        open: /\bopen\b/i.test(details[1] ?? ""),
        blocks: parseBlocks(body),
      });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const image = imageOf(line);
    if (image !== null) {
      flush();
      blocks.push({ kind: "image", ...image });
      continue;
    }

    if (isTableRow(line) && TABLE_SEPARATOR.test(lines[index] ?? "")) {
      flush();
      const header = tableCells(line);
      index += 1; // the separator
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const item = listItemOf(line);
    if (item !== null) {
      if (paragraph.length > 0 || quote.length > 0) flush();
      list.push(item);
      continue;
    }

    if (line.startsWith(">")) {
      if (paragraph.length > 0 || list.length > 0) flush();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }

    // A wrapped continuation of the list item above it, which GitHub also
    // treats as the item's text rather than as a new paragraph.
    if (list.length > 0 && /^\s+/.test(line)) {
      const last = list[list.length - 1];
      if (last !== undefined) last.text = `${last.text}\n${line.trim()}`;
      continue;
    }

    if (list.length > 0 || quote.length > 0) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/**
 * Bold, inline code, links and images, in one pass. An image inside a
 * sentence becomes a link to itself, named after its alt text.
 */
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\s]+\))/g;

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; url: string; label: string; image: boolean };

export function inlineTokens(text: string): InlineToken[] {
  // Splitting on a capturing group interleaves plain text (even indexes) with
  // the tokens it matched (odd indexes).
  const tokens: InlineToken[] = [];
  text.split(INLINE).forEach((part, index) => {
    if (part === "") return;
    if (index % 2 === 0) {
      tokens.push({ kind: "text", text: part });
    } else if (part.startsWith("`")) {
      tokens.push({ kind: "code", text: part.slice(1, -1) });
    } else if (part.startsWith("**") || part.startsWith("__")) {
      tokens.push({ kind: "bold", text: part.slice(2, -2) });
    } else {
      const link = /^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(part);
      const url = link?.[3] ?? part;
      const label = link?.[2] === undefined || link[2] === "" ? url : link[2];
      tokens.push({ kind: "link", url, label, image: link?.[1] === "!" });
    }
  });
  return tokens;
}
