/**
 * Links between memory files that a dream left pointing at nothing.
 *
 * Claude Code's memories link two ways: a Markdown link to a file (`[Title](file.md)`, as `MEMORY.md`
 * does) and a `[[name]]` link to another memory, by its front matter `name:` or its file name. The
 * memory format allows a `[[name]]` with no memory yet (it marks one worth writing), so a `[[name]]`
 * only counts as dangling when it names a memory that existed before the dream and is gone after: one
 * the dream deleted or renamed. A Markdown link to a `.md` file always names a file, so one whose file
 * is missing counts whenever it is found. Links inside code (fenced blocks, inline spans) are examples,
 * not links, and are left out.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { markdownFiles } from "./snapshot";

export interface DanglingLink {
  /** The memory file holding the link, relative to the memory folder. */
  file: string;
  /** The link as written: `[[name]]` or the Markdown link's target. */
  link: string;
}

/** Files larger than this are not scanned; memory files are far smaller. */
const MAX_SCAN_BYTES = 1024 * 1024;

function readText(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8");
    return text.length > MAX_SCAN_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** The text without fenced code blocks and inline code spans, whose links are examples. */
function withoutCode(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "");
}

function frontMatterName(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const name = /^name:\s*(.+?)\s*$/m.exec(match[1]);
  return name ? name[1].replace(/^["']|["']$/g, "") : null;
}

/** Every name a `[[name]]` link may use for the folder's memories: front matter names and file names. */
export function memoryNames(dir: string): string[] {
  const names = new Set<string>();
  for (const file of markdownFiles(dir)) {
    const stem = file.slice(0, -".md".length);
    names.add(stem);
    names.add(path.posix.basename(stem));
    const text = readText(path.join(dir, ...file.split("/")));
    const name = text === null ? null : frontMatterName(text);
    if (name) names.add(name);
  }
  return [...names].sort();
}

function wikiTarget(raw: string): string {
  // `[[name|label]]` and `[[name#section]]` name the memory before the `|` or `#`.
  return raw.split(/[|#]/)[0].trim().replace(/\.md$/, "");
}

/** A Markdown link's target as a path in the folder, or null for a URL, an anchor or a non-`.md` file. */
function markdownTarget(raw: string, from: string): string | null {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (target === "" || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) return null;
  target = target.split(/[?#]/)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    // Left as written.
  }
  if (!target.toLowerCase().endsWith(".md")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  return resolved.startsWith("../") || resolved === ".." ? null : resolved;
}

/**
 * The links in `dir`'s memory files that point at nothing: Markdown links to a missing `.md` file,
 * and `[[name]]` links to a memory named in `namesBefore` that `dir` no longer has.
 */
export function danglingLinks(dir: string, namesBefore: readonly string[]): DanglingLink[] {
  const files = markdownFiles(dir);
  const present = new Set(files);
  const namesAfter = new Set(memoryNames(dir));
  const before = new Set(namesBefore);
  const found: DanglingLink[] = [];
  for (const file of files) {
    const text = readText(path.join(dir, ...file.split("/")));
    if (text === null) continue;
    const prose = withoutCode(text);
    const seen = new Set<string>();
    const add = (link: string) => {
      if (seen.has(link)) return;
      seen.add(link);
      found.push({ file, link });
    };
    for (const match of prose.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const name = wikiTarget(match[1]);
      if (name !== "" && before.has(name) && !namesAfter.has(name)) add(`[[${match[1]}]]`);
    }
    for (const match of prose.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)) {
      const target = markdownTarget(match[1], file);
      if (target !== null && !present.has(target) && !existsSync(path.join(dir, ...target.split("/")))) add(match[1]);
    }
  }
  return found;
}
