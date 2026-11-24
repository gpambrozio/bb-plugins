/**
 * Turning messages and Markdown into short plain text a voice can read: no code, no links, no ids, cut
 * to whole sentences. A ```ui block (bb's cards and tables) is kept as its content, flattened (`../rich`).
 */
import { LinkList, flattenUi } from "../rich";

const URL = /\bhttps?:\/\/[^\s)>\]]+/g;
/** bb's ids (`thr_abc123`, `proj_…`, `env_…`), alone or inside a `@thread:` mention. */
const BB_ID = /@?\b(?:thread|project):(?=[a-z]+_)|\b(?:thr|proj|env|host|evt|creq)_[a-z0-9]+(?:#msg=\d+)?\b/gi;

/** A ```ui block's content as sentences, its links left out. */
function uiSentences(body: string): string {
  const lines = flattenUi(body, new LinkList()).map((line) => {
    const text = line.replace(/\s*\[link \d+\]/g, "").replace(/^- /, "");
    if (!line.startsWith("- Row ")) return text.trim();
    // A cell that held only a link leaves its column's name: drop it.
    return text
      .split("; ")
      .map((part) => part.replace(/\s*[^:;]+:\s*$/, (cut) => (part.trim() === cut.trim() ? "" : ":")).replace(/::$/, ":"))
      .filter((part) => part.trim() !== "")
      .join("; ")
      .replace(/:\s*;\s*/g, ": ")
      .trim();
  });
  return ` ${lines.filter((line) => line !== "").map((line) => (/[.!?:]$/.test(line) ? line : `${line}.`)).join(" ")} `;
}

/**
 * Markdown and bb's markup out, whitespace collapsed. A ```ui block gives its content; other code blocks are
 * dropped whole; inline code keeps its text.
 */
export function plain(text: string): string {
  return text
    .replace(/```ui[^\S\n]*\n([\s\S]*?)(?:```|$)/g, (_all, body: string) => uiSentences(body))
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(URL, " ")
    .replace(BB_ID, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` cut at a word boundary to at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - 1));
  const space = head.lastIndexOf(" ");
  const cut = space >= max * 0.5 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

/** Sentence ends: `.`, `!`, `?` or `…` followed by space. Abbreviations split early; that only shortens. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * The first `count` sentences of `text` that fit in `max` characters. A first sentence longer than that
 * is clipped. Expects text already through `plain`.
 */
export function sentences(text: string, count: number, max: number): string {
  const parts = splitSentences(text);
  let out = "";
  for (const part of parts.slice(0, Math.max(1, count))) {
    const next = out === "" ? part : `${out} ${part}`;
    if (next.length > max) break;
    out = next;
  }
  if (out === "") return clip(parts[0] ?? "", max);
  return out;
}

/** `plain` then `sentences`; null for text that is empty once cleaned. */
export function brief(text: string | null, count: number, max: number): string | null {
  if (text === null) return null;
  const cleaned = plain(text);
  return cleaned === "" ? null : sentences(cleaned, count, max);
}

/** A title as a voice says it: plain, one line, no ids or links. */
export function cleanTitle(title: string): string {
  const cleaned = plain(title);
  return cleaned === "" ? "Untitled" : cleaned;
}
