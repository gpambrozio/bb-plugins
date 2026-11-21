/**
 * What a project is about, from the opening of its instructions file: the first paragraph that says
 * something, after the title, badges, imports and the boilerplate agents' files open with.
 */
import { plain } from "./text";

/** Read in this order; the first that yields a description wins. */
export const DESCRIPTION_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;

/** Paragraphs that only say what the file is, which every generated AGENTS.md and CLAUDE.md opens with. */
const BOILERPLATE = [
  /^this file (?:provides|gives|contains) (?:guidance|instructions)/i,
  /^(?:guidance|instructions) for (?:coding )?agents/i,
  /^read (?:this|me) first/i,
  /^see \S+\.md\b/i,
];

function isBoilerplate(paragraph: string): boolean {
  return BOILERPLATE.some((pattern) => pattern.test(paragraph));
}

/** A paragraph that is only structure: a heading, a rule, a table row, an image or badge line, an import. */
function isStructure(paragraph: string): boolean {
  const first = paragraph.trimStart();
  return (
    /^#{1,6}\s/.test(first) ||
    /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(first) ||
    first.startsWith("|") ||
    first.startsWith("@") ||
    /^(?:\[!\[|!\[|<img|<p|<div|<a |<picture|<h\d)/i.test(first) ||
    /^```/.test(first)
  );
}

/**
 * The description in a Markdown file's text, cleaned to plain words; null when nothing is left once the
 * front matter, headings, imports and boilerplate are skipped.
 */
export function describe(markdown: string): string | null {
  const body = markdown.replace(/^﻿/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const withoutCode = body.replace(/```[\s\S]*?(?:```|$)/g, "\n\n").replace(/<!--[\s\S]*?-->/g, "\n\n");
  const paragraphs = withoutCode
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/)
        // A heading line glued to its first paragraph is still only a heading.
        .filter((line) => !/^\s*#{1,6}\s/.test(line))
        .join("\n")
        .trim(),
    )
    .filter((paragraph) => paragraph !== "");
  for (const paragraph of paragraphs) {
    if (isStructure(paragraph)) continue;
    const text = plain(paragraph);
    if (text.length < 12 || isBoilerplate(text)) continue;
    return text;
  }
  return null;
}
