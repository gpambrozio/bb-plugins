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
 * No SDK import, so the app may use it.
 */
import type { MarkableTerminal, ShellTracker } from "./shell-marks";
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

/**
 * What follows the cursor that is not the shell's decoration: text to its
 * right on its line, unless it is a right-hand prompt (zsh's RPROMPT: set
 * apart by a gap and ending at the line's right edge), and any text on the
 * rows below. Empty when nothing is there; a part that does not touch the
 * cursor starts with a space.
 */
export function textAfterCursor(terminal: MarkableTerminal): string {
  const buffer = terminal.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row);
  const parts: string[] = [];
  if (line !== undefined) {
    const right = line.translateToString(false, buffer.cursorX);
    const rightPrompt = /^\s{2,}\S(?:.*\S)?\s{0,2}$/.test(right) && line.translateToString(true).length >= line.length - 2;
    // Text that starts at the cursor continues what is left of it, so it keeps no gap.
    if (right.trim() !== "" && !rightPrompt) parts.push(right.trimEnd().replace(/^\s+/, " "));
  }
  for (let y = row + 1; y < buffer.length; y += 1) {
    const text = buffer.getLine(y)?.translateToString(true).trim() ?? "";
    if (text !== "") parts.push(` ${text}`);
  }
  return parts.join("");
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
