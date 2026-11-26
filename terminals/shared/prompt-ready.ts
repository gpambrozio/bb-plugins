/**
 * Whether a terminal's shell waits at an empty prompt, so a command typed
 * there runs in the shell and nowhere else. Only positive evidence counts;
 * anything the terminal does not show plainly is "not ready".
 *
 * - With shell integration (OSC 133): the shell is at a prompt whose end it
 *   marked (`B`), and nothing is typed after that end, left or right of the
 *   cursor.
 * - Without it (or when its marks are not current): the shell reported its
 *   directory (OSC 7, which shells send just before drawing a prompt), at most
 *   `MAX_PROMPT_ROWS` rows were drawn since, the last of them ends at the
 *   cursor in a prompt sign and a space, that is the only prompt sign in what
 *   was drawn since the report (a program started from the prompt would add
 *   the shell's own prompt line before its own), and nothing follows the
 *   cursor. The report alone proves nothing: any program can print OSC 7.
 *
 * "Nothing follows the cursor" allows a right-hand prompt only when it shows
 * how zsh draws one: past an unwritten cell (see `rightPromptStart`).
 *
 * No SDK import, so the app may use it.
 */
import type { BufferLineLike, CellLike, MarkableTerminal, ShellTracker } from "./shell-marks";
import { textBetween } from "./shell-marks";

/** The signs a prompt may end in (followed by one space) for a shell without marks. */
export const PROMPT_SIGNS = ["$", "%", "#", ">", "❯"] as const;
/** Signs counted as a prompt where they appear followed by a space; the ending ones and other prompt glyphs. */
const COUNTED_SIGNS = [...PROMPT_SIGNS, "➜", "λ", "»", "→", "▶"];
/** The most rows a prompt drawn after a directory report may take, its own last row included. */
export const MAX_PROMPT_ROWS = 4;

export type Readiness =
  | { ready: true; at: { line: number; column: number } }
  | { ready: false; reason: "full-screen" | "running" | "no-prompt" }
  | { ready: false; reason: "typed"; typed: string };

function signAndSpace(signs: readonly string[]): RegExp {
  return new RegExp(`(?:${signs.map((sign) => sign.replace(/[$^\\.*+?()[\]{}|]/g, "\\$&")).join("|")}) `, "gu");
}

const ENDING = new RegExp(`${signAndSpace(PROMPT_SIGNS).source}$`, "u");
const COUNTED = signAndSpace(COUNTED_SIGNS);

/** A cell nothing was written to, or that was erased: zsh moves the cursor over the gap before its right-hand prompt. */
function unwritten(cell: CellLike | undefined): boolean {
  return cell !== undefined && cell.getChars() === "" && cell.getWidth() !== 0;
}

function blank(cell: CellLike | undefined): boolean {
  if (cell === undefined) return true;
  const chars = cell.getChars();
  return chars === "" || chars.trim() === "";
}

/** How a cell's text is coloured, as a key: "default", or the colour mode and value. */
function fgKey(cell: CellLike): string {
  return cell.isFgDefault() ? "default" : `${cell.getFgColorMode()}:${cell.getFgColor()}`;
}

/**
 * Where a right-hand prompt starts on `line` (zsh's RPROMPT), or the line's
 * length when there is none past `from`. It is a block of written cells
 * ending at most two cells before the right edge, with an unwritten cell just
 * before it: zsh jumps the cursor there (`CSI n C`) rather than printing
 * spaces, so text the user typed, spaces included, never has one.
 */
function rightPromptStart(line: BufferLineLike, from: number): number {
  let x = line.length - 1;
  for (let trailing = 0; trailing < 2 && x >= from && blank(line.getCell(x)); trailing += 1) x -= 1;
  if (x < from || blank(line.getCell(x))) return line.length;
  while (x >= from && !unwritten(line.getCell(x))) x -= 1;
  return x < from ? line.length : x + 1;
}

/** What follows the cursor that is not the shell's right-hand prompt: its text and the colours of its text. */
export interface AfterCursor {
  /** The text, wrapped rows below included; a part that does not touch the cursor starts with a space. "" when nothing is there. */
  text: string;
  /** The colour keys of its non-blank cells. */
  colours: Set<string>;
}

/** What follows the cursor on its row (not a right-hand prompt) and on the rows below. */
export function afterCursor(terminal: MarkableTerminal): AfterCursor {
  const buffer = terminal.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  const colours = new Set<string>();
  const parts: string[] = [];
  const collect = (line: BufferLineLike, from: number, to: number) => {
    for (let x = from; x < to; x += 1) {
      const cell = line.getCell(x);
      if (cell !== undefined && !blank(cell)) colours.add(fgKey(cell));
    }
  };
  const line = buffer.getLine(row);
  if (line !== undefined) {
    const end = rightPromptStart(line, buffer.cursorX);
    const right = line.translateToString(false, buffer.cursorX, end);
    // Text that starts at the cursor continues what is left of it, so it keeps no gap.
    if (right.trim() !== "") parts.push(right.trimEnd().replace(/^\s+/, " "));
    collect(line, buffer.cursorX, end);
  }
  for (let y = row + 1; y < buffer.length; y += 1) {
    const below = buffer.getLine(y);
    if (below === undefined) continue;
    const text = below.translateToString(true).trim();
    if (text !== "") parts.push(` ${text}`);
    collect(below, 0, below.length);
  }
  return { text: parts.join(""), colours };
}

/** What follows the cursor that is not the shell's decoration, as text ("" when nothing). */
export function textAfterCursor(terminal: MarkableTerminal): string {
  return afterCursor(terminal).text;
}

/** The colour keys of the non-blank cells between two places. */
export function coloursBetween(terminal: MarkableTerminal, from: { line: number; column: number }, to: { line: number; column: number }): Set<string> {
  const buffer = terminal.buffer.active;
  const colours = new Set<string>();
  for (let y = Math.max(0, from.line); y <= to.line && y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (line === undefined) continue;
    const end = y === to.line ? to.column : line.length;
    for (let x = y === from.line ? from.column : 0; x < end; x += 1) {
      const cell = line.getCell(x);
      if (cell !== undefined && !blank(cell)) colours.add(fgKey(cell));
    }
  }
  return colours;
}

/**
 * Whether what follows the cursor is only the line editor's suggestion
 * (zsh-autosuggestions draws the rest of a remembered command after the
 * cursor, in a colour of its own, and Enter does not take it): nothing, or
 * text all in one colour that is not the default and not one of the typed
 * text's. The user's own text is in the typed text's colours.
 */
export function onlySuggestion(after: AfterCursor, typedColours: ReadonlySet<string>): boolean {
  if (after.text.trim() === "") return true;
  if (after.colours.size !== 1) return false;
  const [colour] = after.colours;
  return colour !== "default" && !typedColours.has(colour!);
}

/** Whether the shell waits at an empty prompt, and where typing would start. */
export function promptReadiness(terminal: MarkableTerminal, tracker: ShellTracker): Readiness {
  if (tracker.fullScreen()) return { ready: false, reason: "full-screen" };
  if (tracker.hasIntegration() && tracker.phase() === "running") return { ready: false, reason: "running" };
  const buffer = terminal.buffer.active;
  const cursor = { line: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
  const after = textAfterCursor(terminal);

  const promptEnd = tracker.hasIntegration() ? tracker.promptEndAt() : null;
  if (promptEnd !== null) {
    const before = textBetween(terminal, promptEnd, cursor).text.trimStart();
    // `textBetween` trims the row's end, which loses a space just before the cursor.
    const gap = before !== "" && after.startsWith(" ") === false && buffer.getLine(cursor.line)?.translateToString(false, cursor.column - 1, cursor.column) === " ";
    const typed = (before + (gap ? " " : "") + after).trim();
    return typed === "" ? { ready: true, at: cursor } : { ready: false, reason: "typed", typed };
  }

  const report = tracker.directoryReportAt();
  if (report === null || cursor.line < report.line || cursor.line - report.line >= MAX_PROMPT_ROWS) {
    return { ready: false, reason: "no-prompt" };
  }
  const rows: string[] = [];
  for (let y = report.line; y <= cursor.line; y += 1) {
    const line = buffer.getLine(y);
    if (line === undefined) return { ready: false, reason: "no-prompt" };
    const from = y === report.line ? report.column : 0;
    rows.push(y === cursor.line ? line.translateToString(false, from, cursor.column) : line.translateToString(true, from));
  }
  const drawn = rows.join("\n");
  const cursorRow = rows.at(-1) ?? "";
  if (!ENDING.test(cursorRow) || (drawn.match(COUNTED) ?? []).length !== 1) return { ready: false, reason: "no-prompt" };
  if (after !== "") return { ready: false, reason: "typed", typed: after.trim() };
  return { ready: true, at: cursor };
}
