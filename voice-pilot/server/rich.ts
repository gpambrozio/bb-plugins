/**
 * A thread's reply in full, as text the voice model can use: bb's ```ui blocks (cards, tables, metrics,
 * steps, …) flattened to lines and rows, other code blocks kept and marked, and every link numbered, so
 * the model can name what is in a table and open a link by its number.
 *
 * A ```ui block is a small expression language: calls (`Card("Title", [ … ])`, `Table(headers, rows,
 * source: "…")`, `Metric(label, value, detail, tone: "good")`), arrays, `{ key: value }` objects and strings.
 * `parseUi` reads it; a block it cannot read is given as its raw text, so nothing in it is lost.
 */

export type UiValue = string | number | boolean | null | UiValue[] | UiObject | UiCall;
export interface UiObject {
  kind: "object";
  entries: Record<string, UiValue>;
}
export interface UiCall {
  kind: "call";
  name: string;
  args: UiValue[];
  named: Record<string, UiValue>;
}

class Reader {
  private at = 0;

  constructor(private readonly text: string) {}

  private space(): void {
    for (;;) {
      while (this.at < this.text.length && /\s/u.test(this.text[this.at] ?? "")) this.at += 1;
      if (this.text.startsWith("//", this.at)) {
        const end = this.text.indexOf("\n", this.at);
        this.at = end === -1 ? this.text.length : end;
        continue;
      }
      return;
    }
  }

  private fail(what: string): never {
    throw new Error(`${what} at ${this.at}`);
  }

  private peek(): string {
    this.space();
    return this.text[this.at] ?? "";
  }

  private take(char: string): boolean {
    if (this.peek() !== char) return false;
    this.at += 1;
    return true;
  }

  private expect(char: string): void {
    if (!this.take(char)) this.fail(`expected ${char}`);
  }

  /** Values to the end of the text, separated by commas or new lines. */
  all(): UiValue[] {
    const out: UiValue[] = [];
    while (this.peek() !== "") {
      out.push(this.value());
      this.take(",");
    }
    return out;
  }

  private string(): string {
    const quote = this.text[this.at] as string;
    this.at += 1;
    let out = "";
    while (this.at < this.text.length) {
      const char = this.text[this.at] as string;
      this.at += 1;
      if (char === quote) return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const next = this.text[this.at] ?? "";
      this.at += 1;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(this.text.slice(this.at, this.at + 4))) {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.at, this.at + 4), 16));
        this.at += 4;
      } else out += next;
    }
    return this.fail("unterminated string");
  }

  private word(): string {
    const match = /^[A-Za-z_$][\w$.-]*/u.exec(this.text.slice(this.at));
    if (match === null) this.fail("unexpected character");
    this.at += match[0].length;
    return match[0];
  }

  /** A `name:` ahead (an object key or a named argument), taken; null when there is none. */
  private key(): string | null {
    this.space();
    const start = this.at;
    let name: string;
    const char = this.text[this.at] ?? "";
    if (char === '"' || char === "'") name = this.string();
    else if (/[A-Za-z_$]/u.test(char)) name = this.word();
    else return null;
    if (this.take(":")) return name;
    this.at = start;
    return null;
  }

  value(): UiValue {
    const char = this.peek();
    if (char === '"' || char === "'" || char === "`") return this.string();
    if (char === "[") {
      this.at += 1;
      const items: UiValue[] = [];
      while (!this.take("]")) {
        if (this.peek() === "") this.fail("unterminated array");
        items.push(this.value());
        this.take(",");
      }
      return items;
    }
    if (char === "{") {
      this.at += 1;
      const entries: Record<string, UiValue> = {};
      while (!this.take("}")) {
        if (this.peek() === "") this.fail("unterminated object");
        const key = this.key();
        if (key === null) this.fail("expected a key");
        entries[key] = this.value();
        this.take(",");
      }
      return { kind: "object", entries };
    }
    const number = /^-?\d+(?:\.\d+)?/u.exec(this.text.slice(this.at));
    if (number !== null) {
      this.at += number[0].length;
      return Number(number[0]);
    }
    if (!/[A-Za-z_$]/u.test(char)) this.fail("unexpected character");
    const name = this.word();
    if (this.take("(")) {
      const call: UiCall = { kind: "call", name, args: [], named: {} };
      while (!this.take(")")) {
        if (this.peek() === "") this.fail("unterminated call");
        const key = this.key();
        if (key === null) call.args.push(this.value());
        else call.named[key] = this.value();
        this.take(",");
      }
      return call;
    }
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null" || name === "undefined") return null;
    return name;
  }
}

/** The values a ```ui block holds, or null when it is not one this can read. */
export function parseUi(source: string): UiValue[] | null {
  try {
    return new Reader(source).all();
  } catch {
    return null;
  }
}

// --- Links ------------------------------------------------------------------------------------------

export interface ReplyLink {
  /** Its number in the text: "[link 3]". */
  n: number;
  url: string;
  /** The text the link was on, when it had one. */
  text?: string;
}

/** A URL as compared with another: no trailing slash, the scheme and host in lower case. */
function comparable(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.replace(/^[a-z]+:\/\/[^/]+/iu, (head) => head.toLowerCase());
}

/** Numbers each distinct link once, for a whole session: "[link N]" in the text. */
export class LinkList {
  readonly links: ReplyLink[] = [];

  byNumber(n: number): ReplyLink | undefined {
    return this.links.find((link) => link.n === n);
  }

  byUrl(url: string): ReplyLink | undefined {
    const wanted = comparable(url);
    return this.links.find((link) => comparable(link.url) === wanted);
  }

  ref(url: string, text?: string): string {
    let link = this.byUrl(url);
    if (link === undefined) {
      link = { n: this.links.length + 1, url, ...(text !== undefined && text.trim() !== "" ? { text: text.trim().slice(0, 120) } : {}) };
      this.links.push(link);
    }
    return `[link ${link.n}]`;
  }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/gu;
const THREAD_MENTION = /@thread:(thr_[A-Za-z0-9]+)(?:#msg=(\d+))?/gu;

/** A thread mention (`@thread:thr_…`) as a link: bb opens it as the thread. */
export function threadLink(threadId: string, message?: string): string {
  return `bb:thread/${threadId}${message === undefined ? "" : `#msg=${message}`}`;
}

/** Plain text with its URLs and thread mentions replaced by numbered links. */
function linked(text: string, links: LinkList): string {
  return text
    .replace(URL_IN_TEXT, (url) => links.ref(url))
    .replace(THREAD_MENTION, (_match, id: string, msg: string | undefined) => `a thread ${links.ref(threadLink(id, msg))}`);
}

// --- Flattening -------------------------------------------------------------------------------------

/** Most of one code block that is kept. */
const CODE_MAX = 600;

function scalar(value: UiValue, links: LinkList): string {
  if (value === null) return "";
  if (typeof value === "string") return linked(value.replace(/\s+/gu, " ").trim(), links);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return inline(value, links);
}

/** A value on one line. */
function inline(value: UiValue, links: LinkList): string {
  if (value === null || typeof value !== "object") return scalar(value, links);
  if (Array.isArray(value)) return value.map((item) => inline(item, links)).filter((part) => part !== "").join("; ");
  if (value.kind === "object") return objectLine(value, links);
  return lines(value, links).join(" ");
}

const LEAD_KEYS = ["title", "label", "name", "text"];

function objectLine(value: UiObject, links: LinkList): string {
  const entries = Object.entries(value.entries).filter(([, entry]) => entry !== null && entry !== "");
  const lead = entries.find(([key]) => LEAD_KEYS.includes(key));
  const rest = entries.filter((entry) => entry !== lead);
  const head = lead === undefined ? "" : inline(lead[1], links);
  const tail = rest.map(([key, entry]) => (key === "detail" || key === "description" ? inline(entry, links) : `${key} ${inline(entry, links)}`));
  if (head === "") return tail.join("; ");
  return tail.length === 0 ? head : `${head} (${tail.join("; ")})`;
}

function bullet(text: string): string {
  return `- ${text}`;
}

function table(call: UiCall, links: LinkList): string[] {
  const [headers, rows] = call.args;
  const heads = Array.isArray(headers) ? headers.map((head) => scalar(head, links)) : [];
  const out: string[] = [];
  const title = call.named.title ?? (typeof headers === "string" ? headers : null);
  if (typeof title === "string") out.push(`${scalar(title, links)}:`);
  const body = Array.isArray(rows) ? rows : Array.isArray(headers) && heads.length === 0 ? headers : [];
  body.forEach((row, index) => {
    const cells = Array.isArray(row) ? row : [row];
    const parts = cells
      .map((cell, column) => {
        const text = inline(cell, links);
        if (text === "") return "";
        const head = heads[column] ?? "";
        return head === "" ? text : `${head}: ${text}`;
      })
      .filter((part) => part !== "");
    out.push(bullet(`Row ${index + 1}: ${parts.join("; ")}`));
  });
  return out;
}

/** Which named arguments are said after a call's own content. */
const TRAILING = ["source", "note", "caption", "footer"];

/** A call's lines: cards and rows give their children, tables a row per line, the rest one line each. */
function callLines(call: UiCall, links: LinkList): string[] {
  const name = call.name.replace(/^.*\./u, "");
  const out: string[] = [];
  const children = (value: UiValue | undefined): string[] => (value === undefined ? [] : lines(value, links));
  switch (name) {
    case "Table":
      out.push(...table(call, links));
      break;
    case "Metric":
    case "Stat":
    case "KPI": {
      const [label, value, detail] = call.args.map((arg) => inline(arg, links));
      const tone = typeof call.named.tone === "string" ? call.named.tone : null;
      const extra = [detail, tone === null || tone === "neutral" ? undefined : tone].filter((part) => part !== undefined && part !== "");
      out.push(bullet(`${label ?? ""}: ${value ?? ""}${extra.length === 0 ? "" : ` (${extra.join("; ")})`}`));
      break;
    }
    case "Code": {
      const [code] = call.args;
      const language = typeof call.named.language === "string" ? call.named.language : null;
      out.push(...codeLines(typeof code === "string" ? code : inline(code ?? null, links), language));
      break;
    }
    case "Link":
    case "Button": {
      const [label, target] = call.args;
      const url = typeof target === "string" ? target : typeof call.named.url === "string" ? call.named.url : typeof call.named.href === "string" ? call.named.href : null;
      const text = inline(label ?? null, links);
      out.push(url !== null && /^https?:\/\//u.test(url) ? `${text} ${links.ref(url, text)}` : text);
      break;
    }
    default: {
      // Cards, rows, columns, lists, steps, timelines and anything new: a title line, then the content.
      const [first, ...rest] = call.args;
      const nested = (value: UiValue) => Array.isArray(value) || (typeof value === "object" && value !== null);
      if (first !== undefined && !nested(first)) {
        const title = inline(first, links);
        if (title !== "") out.push(name === "Card" || name === "Section" ? `${title}:` : `${name}: ${title}`);
        for (const arg of rest) out.push(...children(arg));
      } else for (const arg of call.args) out.push(...children(arg));
    }
  }
  for (const [key, value] of Object.entries(call.named)) {
    if (TRAILING.includes(key)) out.push(`(${key}: ${inline(value, links)})`);
    else if (Array.isArray(value)) out.push(...children(value));
  }
  return out;
}

function lines(value: UiValue, links: LinkList): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => (typeof item === "object" && item !== null && !Array.isArray(item) && item.kind === "object" ? [bullet(objectLine(item, links))] : lines(item, links)));
  if (typeof value === "object") return value.kind === "object" ? [bullet(objectLine(value, links))] : callLines(value, links);
  const text = scalar(value, links);
  return text === "" ? [] : [text];
}

function codeLines(code: string, language: string | null): string[] {
  const kept = code.length > CODE_MAX ? `${code.slice(0, CODE_MAX)}\n…(${code.length - CODE_MAX} more characters)` : code;
  return [`Code${language === null || language === "" ? "" : ` (${language})`}, not to be read aloud:`, kept];
}

/** A ```ui block as lines: its content when it parses, else its raw text (links still numbered). */
export function flattenUi(source: string, links: LinkList): string[] {
  const values = parseUi(source);
  if (values === null) return ["(A card bb shows; its raw text:)", linked(source.trim(), links)];
  return values.flatMap((value) => lines(value, links));
}

// --- A whole reply ----------------------------------------------------------------------------------

export interface Readable {
  text: string;
  links: ReplyLink[];
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)(?:\n\1?\2[ \t]*(?=\n|$)|$(?![\s\S]))/gmu;

/**
 * A reply in full, as text: ```ui blocks flattened, other code blocks kept and marked, Markdown links and
 * bare URLs replaced by "[link N]", images by their alt text, emphasis marks dropped; lines kept. `links`
 * is the session's list, so a link keeps its number across reads; the result names the links this text has.
 */
export function readableReply(markdown: string, links: LinkList = new LinkList()): Readable {
  const blocks: string[] = [];
  const hold = (text: string) => {
    blocks.push(text);
    return `\u0000${blocks.length - 1}\u0000`;
  };
  let text = markdown.replace(/\r\n?/gu, "\n").replace(FENCE, (_all, _indent: string, _fence: string, language: string, body: string) =>
    hold(language.toLowerCase() === "ui" ? flattenUi(body, links).join("\n") : codeLines(body.replace(/\n$/u, ""), language === "" ? null : language).join("\n")),
  );
  text = text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_all, alt: string) => (alt.trim() === "" ? "" : `(image: ${alt.trim()})`))
    .replace(/\[([^\]]+)\]\((@thread:thr_[A-Za-z0-9]+(?:#msg=\d+)?)\)/gu, (_all, label: string, mention: string) => {
      const [, id, msg] = /@thread:(thr_[A-Za-z0-9]+)(?:#msg=(\d+))?/u.exec(mention) ?? [];
      return `${label} ${links.ref(threadLink(id ?? "", msg), label)}`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, (_all, label: string, url: string) => `${label} ${links.ref(url, label)}`)
    .replace(/<(https?:\/\/[^>\s]+)>/gu, (_all, url: string) => links.ref(url));
  text = linked(text, links)
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/\u0000(\d+)\u0000/gu, (_all, index: string) => blocks[Number(index)] ?? "")
    .trim();
  return { text, links: linksIn(text, links) };
}

/** The links `text` names, by their "[link N]", from `links`. */
export function linksIn(text: string, links: LinkList): ReplyLink[] {
  const numbers = new Set([...text.matchAll(/\[link (\d+)\]/gu)].map((match) => Number(match[1])));
  return links.links.filter((link) => numbers.has(link.n));
}

/** `text` in parts of at most `max` characters, cut at line ends where it can be. */
export function parts(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "" || out.length === 0) out.push(rest);
  return out;
}
