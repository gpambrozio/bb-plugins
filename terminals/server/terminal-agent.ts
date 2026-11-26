/**
 * What the agent a tab asked for help can do in that tab: read what the
 * terminal shows, and run a command in its shell and wait for the result.
 *
 * The shell is the user's own, interactive, so `run` types the command
 * where the user would and the user sees it echoed. It types only where the
 * terminal shows plainly that the shell waits at an empty prompt
 * (shared/prompt-ready.ts), one command per tab at a time, and presses Enter
 * only once the shell has echoed exactly that command after the prompt: if the
 * line shows anything else (the user typed at the same moment, or the program
 * there does not echo like a shell), it erases what it typed and runs nothing.
 *
 * The user's keystrokes reach bb's terminal without passing through this
 * plugin, so nothing here can hold them off. The echo check narrows the gap to
 * the moment between reading the echo and pressing Enter.
 *
 * bb keeps each terminal's raw output; this file replays its tail into a
 * headless xterm sized like the shell, so what the agent reads is what the
 * terminal shows, not escape sequences. No SDK import: bb's calls are ports.
 */
import { Terminal } from "@xterm/headless";

import { afterCursor, coloursBetween, onlySuggestion, promptReadiness, PROMPT_SIGNS, type Readiness } from "../shared/prompt-ready";
import { lastLines, ShellTracker, textBetween, type FinishedCommand, type MarkableTerminal } from "../shared/shell-marks";

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
  announce(terminalId: string, command: string): void;
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
/** How often the terminal is read while waiting for the shell to echo the typed command. */
export const ECHO_POLL_MS = 50;
/** How long the shell has to echo the typed command before it is erased unrun. */
export const ECHO_TIMEOUT_MS = 5_000;
/** The key that erases one character before the cursor (DEL), in a shell and in a terminal's line editing. */
const ERASE = "\u007f";

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
    readonly terminalId: string,
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

function stateLine(tracker: ShellTracker, readiness: Readiness): string {
  if (readiness.ready === false && readiness.reason === "full-screen") return "A full-screen program (an editor, a pager or similar) has the terminal.";
  if (readiness.ready === false && readiness.reason === "running") return "A command is running.";
  const typed = readiness.ready === false && readiness.reason === "typed" ? ` Something is typed there and not run yet ("${readiness.typed}").` : "";
  if (tracker.hasIntegration() && tracker.phase() === "prompt") return `The shell is at its prompt.${typed}`;
  const known = tracker.stoppedMarks()
    ? "This shell stopped reporting its prompt and exit codes: the OSC 133 marks came from another shell (one over ssh that has ended, say), and the shell at the prompt now sends none."
    : tracker.hasIntegration()
      ? "The shell's marks do not say it is at a prompt."
      : "This shell does not report its prompt or exit codes (no OSC 133 shell integration).";
  if (readiness.ready) return `${known} The terminal shows its prompt, empty.`;
  if (typed !== "") return `${known}${typed}`;
  return `${known} The terminal does not show an empty shell prompt, so whether a command is running is not known.`;
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
      stateLine(replay.tracker, promptReadiness(replay.screen.terminal, replay.tracker)),
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
 * Runs one task per terminal at a time, in the order they ask. A waiter
 * that is cancelled leaves the queue at once, but its place in the chain
 * still waits for the task before it, so a later caller never overtakes a
 * task that is still running.
 */
export class TerminalLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(terminalId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const before = this.tails.get(terminalId) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = before.then(() => mine);
    this.tails.set(terminalId, tail);
    // Forget the chain once everything in it is done, unless someone joined after.
    void tail.then(() => {
      if (this.tails.get(terminalId) === tail) this.tails.delete(terminalId);
    });
    try {
      await waitFor(before, signal);
      return await task();
    } finally {
      release();
    }
  }
}

/** `promise`, or a rejection once `signal` aborts first. */
function waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function stopped(): TerminalToolError {
  return new TerminalToolError("Stopped before anything was typed.");
}

/** The refusal for a terminal that is not waiting at an empty prompt. */
function notReady(readiness: Exclude<Readiness, { ready: true }>, where: string): TerminalToolError {
  switch (readiness.reason) {
    case "full-screen":
      return new TerminalToolError(`A full-screen program has the terminal ${where}, so nothing was typed. Ask the user to leave it first.`);
    case "running":
      return new TerminalToolError(
        `A command is still running in ${where}, so nothing was typed. Read the terminal again later, or ask the user to stop it.`,
      );
    case "typed":
      return new TerminalToolError(
        `The user has typed something at the prompt in ${where} and not run it yet ("${readiness.typed}"), so nothing was typed over it.`,
      );
    case "no-prompt":
      return new TerminalToolError(
        [
          `Nothing was typed: the terminal ${where} does not plainly show its shell waiting at an empty prompt.`,
          "This shell does not mark its prompt (OSC 133 shell integration), so a command is typed only at a prompt the shell drew right after reporting its directory (OSC 7),",
          `ending in ${PROMPT_SIGNS.join(" ")} and a space, with nothing typed after it. A program may be waiting for input there (a password, a question, a REPL), or the prompt has another shape.`,
          "To fix it: if a program is waiting or something is typed, ask the user to finish or clear it, then try again.",
          "If the shell is idle and this keeps happening, the user can turn on its shell integration (the OSC 133 script of WezTerm, Ghostty, kitty or iTerm2, or the lines in the Terminals plugin's README),",
          "or use a prompt that ends in one of those signs and a shell that reports its directory (oh-my-zsh does). Until then, ask the user to run the command themselves.",
        ].join(" "),
      );
  }
}

/** What `runCommand` needs besides the tab and the command. */
export interface RunContext {
  signal: AbortSignal;
  /** Throws a `TerminalToolError` once the calling chat may no longer type into the tab. */
  checkAccess(): void;
  locks: TerminalLocks;
  makeScreen?: (cols: number, rows: number) => Screen;
}

/** Throws when the call was stopped or the chat lost the tab. */
function checkStillWanted(context: RunContext, what: string): void {
  if (context.signal.aborted) throw new TerminalToolError(`Stopped ${what}.`);
  context.checkAccess();
}

/**
 * Types `command` into the tab's shell, presses Enter once the shell echoed
 * it, and waits for it: until the shell says it finished (with shell
 * integration), or its output has been quiet for `QUIET_MS` (without), or
 * `timeoutMs` passes, when it is left running.
 */
export async function runCommand(
  ports: AgentTerminalPorts,
  tab: TabFacts,
  options: { command: string; timeoutMs?: number },
  context: RunContext,
): Promise<string> {
  const command = checkCommand(options.command);
  const timeoutMs = Math.max(1_000, Math.min(MAX_RUN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS));
  return context.locks.run(tab.terminalId, context.signal, () => typeAndWait(ports, tab, command, timeoutMs, context));
}

async function typeAndWait(ports: AgentTerminalPorts, tab: TabFacts, command: string, timeoutMs: number, context: RunContext): Promise<string> {
  const { signal } = context;
  checkStillWanted(context, "before anything was typed");
  const session = await usableSession(ports, tab);
  const replay = new Replay(ports, tab.terminalId, session, context.makeScreen ?? headlessScreen);
  try {
    await replay.catchUp(TAIL_BYTES);
    const { tracker } = replay;
    const terminal = replay.screen.terminal;
    const where = describeTab(tab);
    const readiness = promptReadiness(terminal, tracker);
    if (!readiness.ready) throw notReady(readiness, where);
    checkStillWanted(context, "before anything was typed");

    // Typing starts at the cursor, which is where the readiness check found the empty prompt.
    const startMarker = terminal.registerMarker(0);
    const startColumn = readiness.at.column;
    let finished: FinishedCommand | null = null;
    let timedOut = false;
    const stop = tracker.onFinished((done) => {
      finished ??= done;
    });
    const buffer = terminal.buffer.active;
    try {
      const echo = new EchoWatch(ports, replay, startMarker, startColumn, command, tracker.eventCount());
      await ports.input(tab.terminalId, command);
      const seen = await echo.settle(ECHO_TIMEOUT_MS, signal);
      let refusal: string | null = null;
      if (seen === "stopped") refusal = "Stopped before the command was run.";
      else if (seen.kind !== "ok") {
        refusal = `Nothing was run in ${where}: after typing \`${command}\` the line did not show exactly that command (it showed "${seen.shown}"), so Enter was not pressed. The user may have typed at the same moment, or the program there does not echo like a shell.`;
      } else {
        try {
          checkStillWanted(context, "before the command was run");
        } catch (error) {
          refusal = (error as Error).message;
        }
      }
      if (refusal !== null) throw await echo.rollBack(refusal, seen === "stopped");
      await ports.input(tab.terminalId, "\r");
      ports.announce(tab.terminalId, command);
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
      startMarker?.dispose();
      const header = `Ran \`${command}\` in ${where}: it ${exitText(done.exitCode)}.${done.cwd === null ? "" : ` The shell's directory is ${done.cwd}.`}`;
      if (done.output === "") return `${header}\nIt printed nothing.`;
      return `${header}\n${done.truncated ? "The last lines it printed" : "It printed"}:\n\n${fence(done.output)}`;
    }
    const since =
      startMarker === undefined || startMarker.isDisposed
        ? lastLines(terminal, DEFAULT_READ_LINES)
        : textBetween(terminal, { line: startMarker.line, column: startColumn }, { line: buffer.length - 1, column: Number.MAX_SAFE_INTEGER });
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

/**
 * A command line without its backslash escapes. zsh's url-quote-magic (on in
 * oh-my-zsh) escapes `?`, `&` and the like as a URL is typed, which the shell
 * reads as the same command.
 */
function unescaped(line: string): string {
  return line.replace(/\\(.)/g, "$1");
}

/**
 * What the line shows after the command was typed: "ok" when it is exactly
 * the command (backslash escapes the line editor added aside), the cursor
 * right after it, nothing but the line editor's suggestion or a right-hand
 * prompt after it, and the shell has sent no mark or directory report since
 * the readiness check; "pending" while it shows only the start of it; else
 * "differs". `shown` is the line from where typing started.
 */
type Echo = { kind: "ok" | "pending" | "differs"; shown: string };

/** Watches the echo of a typed command, and takes it back when it may be. */
class EchoWatch {
  constructor(
    private readonly ports: AgentTerminalPorts,
    private readonly replay: Replay,
    private readonly startMarker: { line: number; isDisposed: boolean } | undefined,
    private readonly startColumn: number,
    private readonly command: string,
    private readonly events: number,
  ) {}

  private observe(): Echo {
    const { tracker } = this.replay;
    const terminal = this.replay.screen.terminal;
    if (this.startMarker === undefined || this.startMarker.isDisposed) return { kind: "differs", shown: "" };
    const buffer = terminal.buffer.active;
    const start = { line: this.startMarker.line, column: this.startColumn };
    const cursor = { line: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
    const before = cursor.line > start.line || (cursor.line === start.line && cursor.column >= start.column);
    const typed = before ? textBetween(terminal, start, cursor).text.trim() : "";
    const after = afterCursor(terminal);
    const shown = `${typed}${after.text}`.trim();
    if (!before || tracker.eventCount() !== this.events || tracker.fullScreen()) return { kind: "differs", shown };
    if (!onlySuggestion(after, coloursBetween(terminal, start, cursor))) return { kind: "differs", shown };
    if (unescaped(typed) === unescaped(this.command)) return { kind: "ok", shown: typed };
    return unescaped(this.command).startsWith(unescaped(typed)) ? { kind: "pending", shown } : { kind: "differs", shown };
  }

  /**
   * Reads the terminal until the echo is "ok" or "differs", or `timeoutMs`
   * passes (when it is what it was then). "stopped" when `signal` aborts.
   */
  async settle(timeoutMs: number, signal: AbortSignal | null): Promise<Echo | "stopped"> {
    const deadline = this.ports.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return "stopped";
      await this.replay.catchUp();
      const seen = this.observe();
      if (seen.kind !== "pending" || this.ports.now() >= deadline) return seen;
      try {
        await this.ports.sleep(ECHO_POLL_MS, signal ?? new AbortController().signal);
      } catch {
        return "stopped";
      }
    }
  }

  /**
   * Takes the typed command back, without Enter, and returns the refusal to
   * report. It erases only a line that holds exactly the agent's text and
   * nothing after it; anything else (the user typed into it, moved the
   * cursor, or nothing echoed) is left as it is, since erasing would take
   * the user's text with it, and the refusal says so.
   */
  async rollBack(reason: string, stopped: boolean): Promise<TerminalToolError> {
    // A stop can come before the echo did: give the echo its time, without the stop.
    const seen = await this.settle(stopped ? ECHO_TIMEOUT_MS : 0, null);
    if (seen !== "stopped" && seen.kind === "ok") {
      await this.ports.input(this.replay.terminalId, ERASE.repeat([...seen.shown].length));
      return new TerminalToolError(`${reason} What was typed was erased.`);
    }
    const reads = seen === "stopped" || seen.shown === "" ? "" : ` (it reads "${seen.shown}")`;
    return new TerminalToolError(
      `${reason} The line does not hold just the agent's text${reads}, so nothing was erased either: ask the user to look at the prompt and clear what is there before running anything.`,
    );
  }
}
