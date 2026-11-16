/**
 * The first mate's backlog, `data/backlog.md` in its home.
 *
 * The first mate writes it with its own file tools and the board reads it, so
 * the format is a contract between an agent and a parser. It is kept to what
 * an agent reliably reproduces — three headings and one line per item — and the
 * parser is lenient about everything else: unknown `(key: value)` groups are
 * read and ignored, a missing field is `null`, and a line it cannot read is
 * skipped rather than failing the board.
 *
 *     ## In flight
 *     - [ ] fix-flaky-login - Fix the flaky login test (project: web) (kind: ship) (mode: direct-PR) (thread: thr_3f2a…)
 *     ## Queued
 *     - [ ] dark-mode - Add dark mode (project: web) (blocked-by: fix-flaky-login)
 *     - [ ] pick-db - Choose the database (kind: captain) (hold: Postgres or SQLite?) (actions: Postgres => Use Postgres for web | SQLite => Use SQLite for web)
 *     ## Done
 *     - [x] fix-typo - Fix the typo https://github.com/you/web/pull/41 (merged 2026-09-21)
 *
 * Every `(key: value)` group runs to its balanced closing parenthesis, so a value may hold parentheses
 * (`(note: merged main (#206) in)`) and still stays out of the title; see `takeGroups`. `(actions: …)` is
 * read first, with rules of its own for the buttons it describes; see `takeActions`.
 *
 * The item shape is `BacklogItem` in `shared/types.ts`, which the board draws.
 */
import type { BacklogAction, BacklogItem, BacklogSection } from "../shared/types";

const SECTION_HEADINGS: ReadonlyArray<[RegExp, BacklogSection]> = [
  [/^in[\s-]*flight\b/i, "in-flight"],
  [/^(queued|queue|next|charted)\b/i, "queued"],
  [/^(done|landed|finished)\b/i, "done"],
];

const ITEM_LINE = /^\s*[-*]\s+\[([ xX~-])\]\s+(.+)$/;
/** Sticky: the start of a `(key: value)` group, tried at each `(` outside every other group. */
const GROUP_START = /\(([a-zA-Z][\w-]*)\s*:/y;
const OUTCOME = /\((merged|done|landed|closed|failed|abandoned)\s+([^()]*)\)/i;
/** `(since 2026-09-20)`, which the charter spells without a colon. */
const SINCE = /\(since\s+([^():]*)\)/i;
const URL = /https?:\/\/[^\s()<>]+/;
const REPORT_PATH = /\bdata\/[\w.-]+\/report\.md\b/;
/** `id - title`, with an en or em dash accepted as the separator too. */
const ID_AND_TITLE = /^([\w.-]{1,64})\s+[-–—]\s+(.*)$/;
/** Sticky: tried at each `(` outside every other group. */
const ACTIONS_START = /\(actions\s*:/iy;
/** Between an action's label and its prompt. The Paseo port reads the same field by the same rules. */
const ARROW = " => ";
/** The characters a backslash makes literal inside `(actions: …)`. Before anything else it is kept. */
const ESCAPABLE = new Set(["\\", "|", "(", ")"]);

/** One character of an actions field, and whether a backslash made it literal. */
type Token = { char: string; escaped: boolean };

/**
 * Takes every `(actions: Label => prompt | Label => prompt)` field out of a backlog line, returning the
 * line without them and the buttons the first one describes.
 *
 * - Only a field outside every other parenthesis counts: an `(actions:` inside `(hold: …)`, or inside
 *   any other group, is that group's text and is left alone. Parentheses outside the field are counted
 *   as written (no escapes there), and a stray `)` outside any group is ignored.
 * - The field runs from `(actions:` (any case) to its matching `)`. Parentheses inside are counted, so a
 *   balanced pair — `(see web#42)`, a URL with `(` and `)` — needs no escaping.
 * - A backslash makes the next `\`, `|`, `(` or `)` literal: `\|` is a pipe inside a prompt, `\)` a lone
 *   closing parenthesis. A backslash before any other character is kept as written.
 * - `|` separates the buttons. In each, the label is the text before the first ` => ` (spaces included)
 *   and the prompt is all of the text after it, so a prompt may hold more and a label none. Both are
 *   trimmed.
 * - A button with no ` => `, an empty label or an empty prompt is skipped. A field with no matching `)`
 *   runs to the end of the line and gives no buttons. Either way the rest of the line still reads.
 * - Only the first field gives buttons; any later one is taken out of the line all the same.
 */
export function takeActions(body: string): { rest: string; actions: BacklogAction[] } {
  let rest = "";
  let actions: BacklogAction[] | null = null;
  let from = 0;
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "(" && depth === 0) {
      ACTIONS_START.lastIndex = index;
      const start = ACTIONS_START.exec(body);
      if (start !== null) {
        rest += body.slice(from, index);
        const field = readField(body, index + start[0].length);
        if (actions === null) actions = field.tokens === null ? [] : toActions(field.tokens);
        from = index = field.end;
        continue;
      }
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    index += 1;
  }
  rest += body.slice(from);
  return { rest, actions: actions ?? [] };
}

/** The tokens up to the `)` that closes the field and the index after it; null tokens when none does. */
function readField(body: string, start: number): { tokens: Token[] | null; end: number } {
  const tokens: Token[] = [];
  let depth = 1;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index] ?? "";
    const next = body[index + 1];
    if (char === "\\" && next !== undefined && ESCAPABLE.has(next)) {
      tokens.push({ char: next, escaped: true });
      index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0) return { tokens, end: index + 1 };
    tokens.push({ char, escaped: false });
  }
  return { tokens: null, end: body.length };
}

/**
 * Takes every `(key: value)` group out of a line, returning the line without them and each value by its
 * lower-cased key (the last of a repeated key wins).
 *
 * - A group starts at a `(` followed by a key (a letter, then letters, digits, `_` or `-`) and a colon,
 *   anywhere outside another group: a `(key:` inside a group's value is that value's text. Any other
 *   parenthesis — `phase 1 (ask and answer)`, a stray `:(` — stays in the line as written.
 * - The value runs to the `)` that balances the group's `(`, so it may hold balanced parentheses of its
 *   own. A backslash makes the next `\`, `|`, `(` or `)` literal, as in `(actions: …)`.
 * - A group with no balancing `)` ends at its first `)` instead, or just before the next `(key:` when that
 *   comes first, or at the end of the line, so one missing parenthesis neither swallows the groups after
 *   it nor leaves its text in the title.
 */
export function takeGroups(body: string): { rest: string; groups: Map<string, string> } {
  const groups = new Map<string, string>();
  let rest = "";
  let from = 0;
  let index = body.indexOf("(");
  while (index !== -1) {
    GROUP_START.lastIndex = index;
    const start = GROUP_START.exec(body);
    if (start === null) {
      index = body.indexOf("(", index + 1);
      continue;
    }
    rest += body.slice(from, index);
    const value = readValue(body, index + start[0].length);
    groups.set((start[1] ?? "").toLowerCase(), value.text);
    from = value.end;
    index = body.indexOf("(", from);
  }
  rest += body.slice(from);
  return { rest, groups };
}

/** A group's value from just after its colon: balanced when it can be, else up to its first `)` or the next group. */
function readValue(body: string, start: number): { text: string; end: number } {
  const field = readField(body, start);
  if (field.tokens !== null) return { text: field.tokens.map((token) => token.char).join(""), end: field.end };
  const close = body.indexOf(")", start);
  const next = nextGroupStart(body, start);
  if (next !== -1 && (close === -1 || next < close)) return { text: body.slice(start, next), end: next };
  if (close === -1) return { text: body.slice(start), end: body.length };
  return { text: body.slice(start, close), end: close + 1 };
}

/** The index of the first `(key:` at or after `from`, or -1. */
function nextGroupStart(body: string, from: number): number {
  for (let index = body.indexOf("(", from); index !== -1; index = body.indexOf("(", index + 1)) {
    GROUP_START.lastIndex = index;
    if (GROUP_START.test(body)) return index;
  }
  return -1;
}

function toActions(tokens: readonly Token[]): BacklogAction[] {
  const entries: Token[][] = [[]];
  for (const token of tokens) {
    if (token.char === "|" && !token.escaped) entries.push([]);
    else entries.at(-1)?.push(token);
  }
  const actions: BacklogAction[] = [];
  for (const entry of entries) {
    const text = entry.map((token) => token.char).join("");
    // Every ` => ` is unescaped: none of its characters is escapable.
    const arrow = text.indexOf(ARROW);
    if (arrow === -1) continue;
    const label = text.slice(0, arrow).trim();
    const prompt = text.slice(arrow + ARROW.length).trim();
    if (label !== "" && prompt !== "") actions.push({ label, prompt });
  }
  return actions;
}

function sectionOf(heading: string): BacklogSection | null {
  const text = heading.trim();
  for (const [pattern, section] of SECTION_HEADINGS) {
    if (pattern.test(text)) return section;
  }
  return null;
}

function field(groups: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = groups.get(name)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function parseItem(section: BacklogSection, line: string): BacklogItem | null {
  // First, so a prompt's URLs and parentheses never reach the fields or the title below.
  const { rest: body, actions } = takeActions(line);
  const { rest: outside, groups } = takeGroups(body);
  // `blocked-by: x` is written bare as often as in parentheses.
  const bareBlocker = /\bblocked-by:\s*([\w.-]+)/i.exec(outside);
  const outcome = OUTCOME.exec(outside);

  const withoutGroups = outside.replace(OUTCOME, "").replace(SINCE, "").trim();
  const head = ID_AND_TITLE.exec(withoutGroups);
  const id = head?.[1] ?? withoutGroups.split(/\s+/)[0] ?? "";
  if (id === "") return null;
  const rest = head?.[2] ?? withoutGroups.slice(id.length);

  // The charter writes both outside every group; a group's copy (a note, a hold) is the fallback.
  const url = URL.exec(outside)?.[0] ?? URL.exec(body)?.[0] ?? null;
  const reportPath = REPORT_PATH.exec(outside)?.[0] ?? REPORT_PATH.exec(body)?.[0] ?? null;
  const title = rest
    .replace(URL, "")
    .replace(REPORT_PATH, "")
    .replace(/\bblocked-by:\s*[\w.-]+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    section,
    id,
    title: title === "" ? id : title,
    project: field(groups, "project", "repo"),
    kind: field(groups, "kind")?.toLowerCase() ?? null,
    mode: field(groups, "mode"),
    // `agent:` and `crewmate:` are the spellings from before crewmates were bb threads.
    threadId: field(groups, "thread", "agent", "crewmate"),
    hold: field(groups, "hold"),
    actions,
    blockedBy: field(groups, "blocked-by") ?? bareBlocker?.[1] ?? null,
    since: field(groups, "since") ?? SINCE.exec(outside)?.[1]?.trim() ?? null,
    url,
    reportPath: reportPath ?? field(groups, "report"),
    outcome: outcome === null ? null : `${outcome[1]?.toLowerCase()} ${outcome[2]?.trim()}`.trim(),
  };
}

/** Every item under the three known headings, in file order. Anything else is ignored. */
export function parseBacklog(markdown: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  let section: BacklogSection | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = sectionOf(heading[1] ?? "");
      continue;
    }
    if (section === null) continue;
    const item = ITEM_LINE.exec(line);
    if (item === null) continue;
    const parsed = parseItem(section, item[2] ?? "");
    if (parsed !== null) items.push(parsed);
  }
  return items;
}
