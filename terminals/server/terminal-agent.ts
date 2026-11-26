/**
 * What the agent a tab asked for help can do in that tab: read what the
 * terminal shows, and run a command in its shell and wait for the result.
 *
 * The shell is the user's own, interactive, so `run` types the command
 * where the user would and the user sees it echoed. It types only when the
 * shell is ready for it: never into a full-screen program, and — when the
 * shell reports its prompt (OSC 133, shared/shell-marks.ts) — never while a
 * command runs or over something the user has typed and not yet run.
 *
 * bb keeps each terminal's raw output; this file replays its tail into a
 * headless xterm sized like the shell, so what the agent reads is what the
 * terminal shows, not escape sequences. No SDK import: bb's calls are ports.
 */
import { Terminal } from "@xterm/headless";

import { lastLines, lineBeforeCursor, ShellTracker, textBetween, type FinishedCommand, type MarkableTerminal } from "../shared/shell-marks";

/** The parts of a bb terminal session this file reads. */
export interface SessionFacts {
  cols: number;
  rows: number;
  status: "starting" | "running" | "disconnected" | "exited";
  exitCode: number | null;
}

/** bb's terminal calls, and the clock. */
export interface AgentTerminalPorts {
  session(terminalId: string): Promise<SessionFacts | null>;
  output(args: { terminalId: string; sinceSeq?: number; tailBytes?: number }): Promise<{
    chunks: readonly { seq: number; dataBase64: string }[];
    nextSeq: number;
  }>;
  input(terminalId: string, data: string): Promise<void>;
  /** Tells the page the agent typed `command` into the terminal, so it can say so. */
  /** Tells the page the agent typed `command`, at `prompt` (the cursor's line before it). */
  announce(terminalId: string, command: string, prompt: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

/** How the tab is named to the agent. */
export interface TabFacts {
  terminalId: string;
  label: string;
  hostName: string;
}

/** How much of a terminal's kept output is replayed to read it. */
export const TAIL_BYTES = 256 * 1024;
/** How often a running command's output is read while waiting for it. */
export const POLL_MS = 250;
/** Without shell integration, a command counts as done once its output has been quiet this long. */
export const QUIET_MS = 1_500;
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;
export const MAX_RUN_TIMEOUT_MS = 600_000;
export const DEFAULT_READ_LINES = 120;
export const MAX_READ_LINES = 2_000;
/** The longest command `run` types. */
export const MAX_COMMAND_LENGTH = 4_000;

/** A refusal or failure the agent is told about, as the tool's error. */
export class TerminalToolError extends Error {}

/** A headless terminal the shell's output is replayed into. */
export interface Screen {
  readonly terminal: MarkableTerminal;
  write(bytes: Uint8Array): Promise<void>;
  dispose(): void;
}

export function headlessScreen(cols: number, rows: number): Screen {
  const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  return {
    terminal,
    write: (bytes) => new Promise<void>((resolve) => terminal.write(bytes, resolve)),
    dispose: () => terminal.dispose(),
  };
}

function bytesOf(dataBase64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(dataBase64, "base64"));
}

/** A tab's terminal replayed from bb's kept output, kept current by `catchUp`. */
class Replay {
  readonly screen: Screen;
  readonly tracker: ShellTracker;
  private nextSeq = 0;

  constructor(
    private readonly ports: AgentTerminalPorts,
    private readonly terminalId: string,
    session: SessionFacts,
    makeScreen: (cols: number, rows: number) => Screen,
  ) {
    this.screen = makeScreen(Math.max(2, session.cols), Math.max(1, session.rows));
    this.tracker = new ShellTracker(this.screen.terminal);
  }

  /** Writes the output bb has that this replay has not drawn; true when there was any. */
  async catchUp(tailBytes?: number): Promise<boolean> {
    const result = await this.ports.output({
      terminalId: this.terminalId,
      ...(tailBytes === undefined ? { sinceSeq: this.nextSeq } : { tailBytes }),
    });
    let wrote = false;
    for (const chunk of result.chunks) {
      if (chunk.seq < this.nextSeq) continue;
      this.nextSeq = chunk.seq + 1;
      await this.screen.write(bytesOf(chunk.dataBase64));
      wrote = true;
    }
    this.nextSeq = Math.max(this.nextSeq, result.nextSeq);
    return wrote;
  }

  dispose(): void {
    this.tracker.dispose();
    this.screen.dispose();
  }
}

function describeTab(tab: TabFacts): string {
  return tab.label.startsWith(tab.hostName) ? `"${tab.label}"` : `"${tab.label}" on ${tab.hostName}`;
}

function fence(text: string): string {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}text\n${text}\n${marks}`;
}

function exitText(exitCode: number | null): string {
  return exitCode === null ? "finished (the shell did not say how)" : exitCode === 0 ? "succeeded (exit code 0)" : `failed with exit code ${exitCode}`;
}

function describeLast(last: FinishedCommand | null): string | null {
  if (last === null) return null;
  return `The last command, \`${last.command === "" ? "(not shown)" : last.command}\`, ${exitText(last.exitCode)}.`;
}

/** The session, or the refusal for one that cannot be used. */
async function usableSession(ports: AgentTerminalPorts, tab: TabFacts): Promise<SessionFacts> {
  const session = await ports.session(tab.terminalId);
  if (session === null || session.status === "exited") {
    throw new TerminalToolError(`The shell in ${describeTab(tab)} has ended, so nothing can be read from or run in it any more.`);
  }
  if (session.status === "disconnected") {
    throw new TerminalToolError(`The machine of ${describeTab(tab)} is offline. Its shell carries on when it reconnects; try again later.`);
  }
  if (session.status === "starting") throw new TerminalToolError(`The shell in ${describeTab(tab)} is still starting; try again in a moment.`);
  return session;
}

function stateLine(tracker: ShellTracker): string {
  if (tracker.fullScreen()) return "A full-screen program (an editor, a pager or similar) has the terminal.";
  if (tracker.stoppedMarks()) {
    return "This shell stopped reporting its prompt and exit codes: the OSC 133 marks came from another shell (one over ssh that has ended, say), and the shell at the prompt now sends none. Whether a command is running is not known.";
  }
  if (!tracker.hasIntegration()) {
    return "This shell does not report its prompt or exit codes (no OSC 133 shell integration), so whether a command is running is not known.";
  }
  switch (tracker.phase()) {
    case "running":
      return "A command is running.";
    case "prompt":
    case "finished":
      return "The shell is at its prompt.";
    default:
      return "Whether a command is running is not known.";
  }
}

/** What the terminal shows now: its last `lines` lines, where the shell is, and its last command. */
export async function readTerminal(
  ports: AgentTerminalPorts,
  tab: TabFacts,
  options: { lines?: number } = {},
  makeScreen: (cols: number, rows: number) => Screen = headlessScreen,
): Promise<string> {
  const session = await usableSession(ports, tab);
  const replay = new Replay(ports, tab.terminalId, session, makeScreen);
  try {
    await replay.catchUp(TAIL_BYTES);
    const lines = Math.max(1, Math.min(MAX_READ_LINES, options.lines ?? DEFAULT_READ_LINES));
    const shown = lastLines(replay.screen.terminal, lines);
    const cwd = replay.tracker.cwd();
    const parts = [
      `Terminal ${describeTab(tab)}: the user's own interactive shell.${cwd === null ? "" : ` Its directory is ${cwd}.`}`,
      stateLine(replay.tracker),
      describeLast(replay.tracker.last()),
      shown.text === ""
        ? "The terminal shows nothing."
        : `${shown.truncated ? `Its last ${lines} lines` : "What it shows"}:\n\n${fence(shown.text)}`,
    ];
    return parts.filter((part) => part !== null).join("\n");
  } finally {
    replay.dispose();
  }
}

/** The command as typed, or the refusal for one `run` does not type. */
export function checkCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "") throw new TerminalToolError("The command is empty.");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new TerminalToolError(`The command is longer than ${MAX_COMMAND_LENGTH} characters.`);
  // A newline would run what comes before it on its own, and other control characters are keystrokes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TerminalToolError("The command must be one line without control characters; join several with `&&` or `;`.");
  }
  return trimmed;
}

/**
 * Types `command` into the tab's shell and waits for it: until the shell
 * says it finished (with shell integration), or its output has been quiet
 * for `QUIET_MS` (without), or `timeoutMs` passes, when it is left running.
 */
export async function runCommand(
  ports: AgentTerminalPorts,
  tab: TabFacts,
  options: { command: string; timeoutMs?: number },
  signal: AbortSignal,
  makeScreen: (cols: number, rows: number) => Screen = headlessScreen,
): Promise<string> {
  const command = checkCommand(options.command);
  const timeoutMs = Math.max(1_000, Math.min(MAX_RUN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS));
  const session = await usableSession(ports, tab);
  const replay = new Replay(ports, tab.terminalId, session, makeScreen);
  try {
    await replay.catchUp(TAIL_BYTES);
    const { tracker } = replay;
    const where = describeTab(tab);
    if (tracker.fullScreen()) {
      throw new TerminalToolError(`A full-screen program has the terminal ${where}, so nothing was typed. Ask the user to leave it first.`);
    }
    if (tracker.hasIntegration() && tracker.phase() === "running") {
      throw new TerminalToolError(
        `A command is still running in ${where}, so nothing was typed. Read the terminal again later, or ask the user to stop it.`,
      );
    }
    const typed = tracker.pendingInput();
    if (typed !== null && typed !== "") {
      throw new TerminalToolError(
        `The user has typed something at the prompt in ${where} and not run it yet ("${typed}"), so nothing was typed over it.`,
      );
    }

    let finished: FinishedCommand | null = null;
    let timedOut = false;
    const stop = tracker.onFinished((done) => {
      finished ??= done;
    });
    const buffer = replay.screen.terminal.buffer.active;
    const startMarker = replay.screen.terminal.registerMarker(0);
    const startColumn = buffer.cursorX;
    const prompt = lineBeforeCursor(replay.screen.terminal);
    try {
      await ports.input(tab.terminalId, `${command}\r`);
      ports.announce(tab.terminalId, command, prompt);
      const started = ports.now();
      let lastOutputAt = started;
      while (finished === null) {
        if (signal.aborted) throw new TerminalToolError("Stopped while waiting for the command; it may still be running.");
        if (ports.now() - started >= timeoutMs) {
          timedOut = true;
          break;
        }
        if (!tracker.hasIntegration() && ports.now() - lastOutputAt >= QUIET_MS) break;
        await ports.sleep(POLL_MS, signal);
        if (await replay.catchUp()) lastOutputAt = ports.now();
      }
    } finally {
      stop();
    }

    const done = finished as FinishedCommand | null;
    if (done !== null) {
      const header = `Ran \`${command}\` in ${where}: it ${exitText(done.exitCode)}.${done.cwd === null ? "" : ` The shell's directory is ${done.cwd}.`}`;
      if (done.output === "") return `${header}\nIt printed nothing.`;
      return `${header}\n${done.truncated ? "The last lines it printed" : "It printed"}:\n\n${fence(done.output)}`;
    }
    const since =
      startMarker === undefined || startMarker.isDisposed
        ? lastLines(replay.screen.terminal, DEFAULT_READ_LINES)
        : textBetween(replay.screen.terminal, { line: startMarker.line, column: startColumn }, { line: buffer.length - 1, column: Number.MAX_SAFE_INTEGER });
    startMarker?.dispose();
    const shown = since.text === "" ? "Nothing has been printed since." : `The terminal since then:\n\n${fence(since.text)}`;
    if (tracker.hasIntegration()) {
      return `Typed \`${command}\` in ${where}; it is still running after ${Math.round(timeoutMs / 1000)} s and was left running. Read the terminal later for the rest.\n${shown}`;
    }
    const when = timedOut ? `after the ${Math.round(timeoutMs / 1000)} s wait ran out` : "once its output went quiet";
    return `Typed \`${command}\` in ${where}. This shell does not report when a command finishes or its exit code, so this is the terminal ${when}; the command may still be running.\n${shown}`;
  } finally {
    replay.dispose();
  }
}
