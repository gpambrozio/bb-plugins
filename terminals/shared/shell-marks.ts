/**
 * Shell integration: the marks a shell prints around its prompt and each
 * command, read off a terminal as it parses the shell's output.
 *
 * - OSC 133 (FinalTerm's, which fish 4, nushell, WezTerm, kitty, Ghostty and
 *   iTerm2's integration scripts send): `A` a prompt starts, `B` it ends and
 *   the user types, `C` the command runs (its output follows), `D;<exit>` it
 *   finished with that exit status.
 * - OSC 633 (VS Code's), the same letters, plus `E;<command line>`.
 *
 * The tracker works on any xterm.js terminal — the page's `@xterm/xterm` and
 * the server's `@xterm/headless` share the API it uses — and keeps buffer
 * markers at each mark, so the command line and its output are read from the
 * terminal's own rendering: progress redraws, colours and cursor moves are
 * already resolved. No SDK import, so the app may use it.
 */
import { directoryFromOsc7 } from "./osc7";

/** One mark, as parsed from an OSC 133 or 633 sequence's data. */
export type ShellMark =
  | { kind: "prompt-start" }
  | { kind: "prompt-end" }
  | { kind: "command-start" }
  | { kind: "command-end"; exitCode: number | null }
  | { kind: "command-line"; commandLine: string };

/** VS Code escapes `\` as `\\` and characters below 0x20 and `;` as `\xAB` in a 633 command line. */
function unescape633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_whole, escaped: string, hex: string | undefined) =>
    hex === undefined ? escaped : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The mark in an OSC 133 or 633 sequence's data, or null for one this file does not use. */
export function parseShellMark(ident: 133 | 633, data: string): ShellMark | null {
  const [letter = "", ...rest] = data.split(";");
  switch (letter) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "prompt-end" };
    case "C":
      return { kind: "command-start" };
    case "D": {
      const raw = rest[0];
      // `D` alone, or `D;aid=…` (kitty), says the command ended without saying how.
      if (raw === undefined || !/^-?\d+$/.test(raw)) return { kind: "command-end", exitCode: null };
      return { kind: "command-end", exitCode: Number.parseInt(raw, 10) };
    }
    case "E":
      if (ident !== 633 || rest.length === 0) return null;
      // A nonce may follow the command line; the command line is the first field.
      return { kind: "command-line", commandLine: unescape633(rest[0] ?? "") };
    default:
      return null;
  }
}

/** The parts of an xterm.js marker this file uses. */
export interface MarkerLike {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

/** The parts of an xterm.js buffer cell this package uses. */
export interface CellLike {
  /** The cell's text; "" for a cell nothing was written to (or that was erased), and for the right half of a wide character. */
  getChars(): string;
  /** 0 for the right half of a wide character. */
  getWidth(): number;
  isFgPalette(): boolean;
  getFgColor(): number;
  /** Non-zero when the cell is faint (SGR 2). */
  isDim(): number;
}

/** The parts of an xterm.js buffer line this package uses. */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  /** The terminal's width in cells. */
  readonly length: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell(x: number): CellLike | undefined;
}

/** The parts of an xterm.js terminal (`@xterm/xterm` or `@xterm/headless`) this file uses. */
export interface MarkableTerminal {
  readonly parser: { registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void } };
  registerMarker(cursorYOffset?: number): MarkerLike | undefined;
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly cursorX: number;
      readonly cursorY: number;
      readonly baseY: number;
      readonly length: number;
      getLine(y: number): BufferLineLike | undefined;
    };
  };
}

/** A place in the buffer: a marker (so it follows scrolling) and a column. */
interface Place {
  marker: MarkerLike;
  column: number;
}

/** A command the shell said it ran and finished. */
export interface FinishedCommand {
  /** The command line, as the shell drew it after the prompt (or as VS Code's mark gave it); may be empty. */
  command: string;
  /** What it printed, as the terminal shows it, at most `MAX_OUTPUT_LINES` of its last lines. */
  output: string;
  /** Whether lines were dropped from the start of `output`. */
  truncated: boolean;
  /** Its exit status; null when the shell did not say. */
  exitCode: number | null;
  /** The shell's directory when it finished, from OSC 7, when it reports one. */
  cwd: string | null;
}

/**
 * Where the shell is, as far as its marks say: `unknown` until it has sent
 * one (a shell without integration stays there), `prompt` from a prompt's
 * start until a command runs, `running` from then until it finishes,
 * `finished` after that until the next prompt.
 */
export type ShellPhase = "unknown" | "prompt" | "running" | "finished";

/** The most output lines a finished command keeps; the start is dropped first. */
export const MAX_OUTPUT_LINES = 400;

/**
 * The text between two places, a row per line, with lines the terminal
 * wrapped joined back together and trailing blank lines dropped. Keeps at
 * most `maxLines` of the last lines.
 */
export function textBetween(
  terminal: MarkableTerminal,
  from: { line: number; column: number },
  to: { line: number; column: number },
  maxLines: number = MAX_OUTPUT_LINES,
): { text: string; truncated: boolean } {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  const last = Math.min(to.line, buffer.length - 1);
  for (let y = Math.max(0, from.line); y <= last; y += 1) {
    const line = buffer.getLine(y);
    if (line === undefined) continue;
    const start = y === from.line ? from.column : 0;
    const end = y === to.line ? to.column : undefined;
    const text = line.translateToString(true, start, end);
    // A wrapped line's row is joined with untrimmed text, so spaces at the wrap survive.
    if (line.isWrapped && rows.length > 0 && y !== from.line) rows[rows.length - 1] += text;
    else rows.push(text);
  }
  // xterm keeps trailing blanks when an end column is given.
  for (let index = 0; index < rows.length; index += 1) rows[index] = rows[index]!.trimEnd();
  while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
  while (rows.length > 0 && rows[0]!.trim() === "") rows.shift();
  const truncated = rows.length > maxLines;
  return { text: (truncated ? rows.slice(-maxLines) : rows).join("\n"), truncated };
}

/** The last `count` lines of the whole buffer (scrollback and screen), trailing blank lines dropped. */
export function lastLines(terminal: MarkableTerminal, count: number): { text: string; truncated: boolean } {
  const buffer = terminal.buffer.active;
  const end = { line: buffer.length - 1, column: Number.MAX_SAFE_INTEGER };
  return textBetween(terminal, { line: 0, column: 0 }, end, count);
}

/**
 * Follows a terminal's shell-integration marks and OSC 7 directory reports.
 * Attach it before the terminal is written to; `dispose` lets go of its
 * handlers and markers.
 */
export class ShellTracker {
  private phaseNow: ShellPhase = "unknown";
  private promptEnd: Place | null = null;
  private commandStart: Place | null = null;
  private commandLine: string | null = null;
  private lastFinished: FinishedCommand | null = null;
  private directory: string | null = null;
  /** Where the shell last reported its directory (OSC 7), which shells do just before drawing a prompt. */
  private directoryReport: Place | null = null;
  /**
   * A command started (`C`) and has not finished. Kept apart from its start's
   * marker, which goes when the start scrolls out of the scrollback.
   */
  private commandRunning = false;
  private marksSeen = false;
  /** How many marks and directory reports the shell has sent: any of them means it moved on. */
  private events = 0;
  /**
   * A shell drew a prompt (it reported its directory, OSC 7) while the marks
   * said a command was running, and no mark has come since: the shell that
   * sent the marks is gone (an ssh session that ended after its remote shell
   * sent `C` for `exit`) and the one at the prompt now sends none.
   */
  private marksStopped = false;
  private readonly listeners = new Set<(command: FinishedCommand) => void>();
  private readonly phaseListeners = new Set<(phase: ShellPhase) => void>();
  private readonly handlers: { dispose(): void }[];

  constructor(private readonly terminal: MarkableTerminal) {
    const mark = (ident: 133 | 633) => (data: string) => {
      const parsed = parseShellMark(ident, data);
      if (parsed !== null) this.apply(parsed);
      // Handled: xterm has nothing of its own to do with these.
      return true;
    };
    this.handlers = [
      terminal.parser.registerOscHandler(133, mark(133)),
      terminal.parser.registerOscHandler(633, mark(633)),
      terminal.parser.registerOscHandler(7, (data) => {
        const directory = directoryFromOsc7(data);
        // A report that names no directory says nothing about the shell.
        if (directory === null) return false;
        this.events += 1;
        this.directory = directory;
        this.directoryReport?.marker.dispose();
        this.directoryReport = this.here();
        // Shells report their directory as they draw a prompt, so the command the marks
        // said was running is over as far as the page can show. That is a hint only (any
        // program can print OSC 7): it makes the phase unknown, not idle, and a command is
        // typed only at a prompt that shows (shared/prompt-ready.ts). The command's start
        // is kept: a `D` that follows (a shell that reports the directory first) still
        // finishes it.
        if (this.phaseNow === "running") {
          this.marksStopped = true;
          this.setPhase("unknown");
        }
        return false;
      }),
    ];
  }

  /**
   * Whether the shell at the prompt sends shell-integration marks: it has sent
   * some, and has not since drawn a prompt without them (see `stoppedMarks`).
   */
  hasIntegration(): boolean {
    return this.marksSeen && !this.marksStopped;
  }

  /** Whether marks came earlier but the shell at the prompt now sends none (an ssh session with them ended). */
  stoppedMarks(): boolean {
    return this.marksStopped;
  }

  phase(): ShellPhase {
    return this.phaseNow;
  }

  /** The shell's working directory as it last reported it (OSC 7), or null. */
  cwd(): string | null {
    return this.directory;
  }

  /** The last command the shell said finished, or null. */
  last(): FinishedCommand | null {
    return this.lastFinished;
  }

  /** Whether a full-screen program (an editor, a pager) has the terminal. */
  fullScreen(): boolean {
    return this.terminal.buffer.active.type === "alternate";
  }

  /**
   * A count of the marks and directory reports the shell sent. It changing
   * means the shell moved on (a command started, a new prompt), so a check
   * made before it changed no longer holds.
   */
  eventCount(): number {
    return this.events;
  }

  /** Where the prompt ends and typing starts, while the shell is at a prompt with an end mark (`B`); else null. */
  promptEndAt(): { line: number; column: number } | null {
    if (this.phaseNow !== "prompt" || this.promptEnd === null || this.promptEnd.marker.isDisposed) return null;
    return { line: this.promptEnd.marker.line, column: this.promptEnd.column };
  }

  /** Where the shell last reported its directory (OSC 7), while that place is still in the buffer; else null. */
  directoryReportAt(): { line: number; column: number } | null {
    if (this.directoryReport === null || this.directoryReport.marker.isDisposed) return null;
    return { line: this.directoryReport.marker.line, column: this.directoryReport.column };
  }

  /** Calls `listener` each time a command finishes; returns the unsubscribe. */
  onFinished(listener: (command: FinishedCommand) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` each time the phase changes; returns the unsubscribe. */
  onPhase(listener: (phase: ShellPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  dispose(): void {
    for (const handler of this.handlers) handler.dispose();
    this.promptEnd?.marker.dispose();
    this.commandStart?.marker.dispose();
    this.directoryReport?.marker.dispose();
    this.listeners.clear();
    this.phaseListeners.clear();
  }

  private here(): Place | null {
    const marker = this.terminal.registerMarker(0);
    return marker === undefined ? null : { marker, column: this.terminal.buffer.active.cursorX };
  }

  private setPhase(phase: ShellPhase): void {
    if (phase === this.phaseNow) return;
    this.phaseNow = phase;
    for (const listener of this.phaseListeners) listener(phase);
  }

  private apply(mark: ShellMark): void {
    this.events += 1;
    this.marksSeen = true;
    this.marksStopped = false;
    switch (mark.kind) {
      case "prompt-start":
        // A prompt with no end mark yet: whatever follows is prompt until `B`.
        this.promptEnd?.marker.dispose();
        this.promptEnd = null;
        this.dropCommand();
        this.setPhase("prompt");
        return;
      case "prompt-end":
        this.promptEnd?.marker.dispose();
        this.promptEnd = this.here();
        this.dropCommand();
        this.setPhase("prompt");
        return;
      case "command-line":
        this.commandLine = mark.commandLine;
        return;
      case "command-start":
        this.commandStart?.marker.dispose();
        this.commandStart = this.here();
        this.commandRunning = true;
        this.setPhase("running");
        return;
      case "command-end":
        this.finish(mark.exitCode);
        return;
    }
  }

  /**
   * The command line as drawn between the prompt's end and the start of the
   * output, without a right-hand prompt (zsh's RPROMPT, which stays on the
   * line): text set apart by a gap and ending at the line's right edge.
   */
  private drawnCommand(prompt: Place, start: Place): string {
    const buffer = this.terminal.buffer.active;
    const rows: string[] = [];
    for (let y = prompt.marker.line; y <= start.marker.line && y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (line === undefined) continue;
      const from = y === prompt.marker.line ? prompt.column : 0;
      const to = y === start.marker.line ? start.column : line.length;
      let text = line.translateToString(false, from, to);
      const full = line.translateToString(false);
      const right = /\s{2,}(\S(?:.*\S)?)\s{0,2}$/.exec(text);
      if (right !== null && full.trimEnd().length >= line.length - 2) text = text.slice(0, right.index);
      rows.push(text.trim());
    }
    return rows.filter((row) => row !== "").join(" ");
  }

  private dropCommand(): void {
    this.commandStart?.marker.dispose();
    this.commandStart = null;
    this.commandLine = null;
    this.commandRunning = false;
  }

  private finish(exitCode: number | null): void {
    // A `D` with no `C` before it (Enter on an empty line, in many scripts) ran nothing.
    if (!this.commandRunning) {
      this.dropCommand();
      if (this.phaseNow !== "unknown") this.setPhase("finished");
      return;
    }
    const start = this.commandStart;
    const buffer = this.terminal.buffer.active;
    const end = { line: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
    const kept = start !== null && !start.marker.isDisposed;
    // A start that scrolled out of the scrollback (a long build) still ran: its output
    // is what the buffer kept of it, with its beginning lost.
    const output = kept
      ? textBetween(this.terminal, { line: start.marker.line, column: start.column }, end)
      : { ...textBetween(this.terminal, { line: 0, column: 0 }, end), truncated: true };
    let command = this.commandLine;
    if (command === null) {
      const prompt = this.promptEnd;
      command = !kept || prompt === null || prompt.marker.isDisposed ? "" : this.drawnCommand(prompt, start);
    }
    const finished: FinishedCommand = { command, output: output.text, truncated: output.truncated, exitCode, cwd: this.directory };
    this.lastFinished = finished;
    this.dropCommand();
    this.setPhase("finished");
    for (const listener of this.listeners) listener(finished);
  }
}
