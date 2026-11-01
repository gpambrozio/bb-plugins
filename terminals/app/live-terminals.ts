/**
 * Every open tab's terminal, kept for the life of the window — not of the
 * page. Leaving the Terminals page unmounts its React tree; the xterm
 * instance, its scrollback and its socket stay here, keep drawing whatever
 * the shell prints, and the page re-parents the same element when it comes
 * back, at the line it was scrolled to.
 *
 * A reload of the app starts this map empty: each tab then reattaches and bb
 * replays its last 512 KB of output (app/connection.ts).
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { TerminalConnection, terminalSocketUrl, type ConnectionStatus, type SocketLike } from "./connection";
import { currentFontFamily, currentTheme } from "./theme";

export interface LiveTerminal {
  readonly terminalId: string;
  status(): ConnectionStatus;
  /** Calls `listener` on every status change; returns the unsubscribe. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  /** Shows the terminal inside `parent`, where it was left. */
  attach(parent: HTMLElement): void;
  /** Takes it off the page, remembering the line it was scrolled to. */
  detach(): void;
  /** Fits it to its parent and tells bb the new size. */
  fit(): void;
  focus(): void;
  applyTheme(): void;
}

/**
 * The bb terminal calls a tab makes itself: the app SDK's `useSdk().terminals`
 * satisfies this.
 */
export interface TerminalsBackend {
  output(args: { terminalId: string; sinceSeq: number; tailBytes: number }): Promise<{
    chunks: readonly { seq: number; dataBase64: string }[];
  }>;
}

const SCROLLBACK_LINES = 10_000;
/** As much of an exited shell's output as bb replays to a live one. */
const RETAINED_TAIL_BYTES = 512 * 1024;

const live = new Map<string, LiveTerminal & { dispose(): void }>();

function openSocket(terminalId: string, sinceSeq: number): SocketLike {
  return new WebSocket(terminalSocketUrl(window.location, terminalId, sinceSeq)) as unknown as SocketLike;
}

function create(terminalId: string, backend: TerminalsBackend): LiveTerminal & { dispose(): void } {
  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";
  const term = new Terminal({
    scrollback: SCROLLBACK_LINES,
    fontFamily: currentFontFamily(),
    fontSize: 13,
    cursorBlink: true,
    theme: currentTheme(),
    allowProposedApi: false,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const listeners = new Set<(status: ConnectionStatus) => void>();
  const connection = new TerminalConnection({
    terminalId,
    openSocket,
    write: (bytes, drawn) => term.write(bytes, drawn),
    onStatus: (status) => {
      for (const listener of listeners) listener(status);
    },
    readRetained: async (sinceSeq) =>
      (await backend.output({ terminalId, sinceSeq, tailBytes: RETAINED_TAIL_BYTES })).chunks,
  });
  term.onData((data) => connection.sendInput(data));
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
    connection.sendBytes(bytes);
  });

  let opened = false;
  /** Where the view was when it left the page; null for "following the output". */
  let savedLine: number | null = null;

  function fit(): void {
    if (!opened || element.clientWidth === 0 || element.clientHeight === 0) return;
    const proposed = fitAddon.proposeDimensions();
    if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const cols = Math.max(2, Math.min(500, proposed.cols));
    const rows = Math.max(1, Math.min(200, proposed.rows));
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    connection.resize(cols, rows);
  }

  connection.connect();

  return {
    terminalId,
    status: () => connection.current,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(parent) {
      if (element.parentElement !== parent) parent.appendChild(element);
      if (!opened) {
        term.open(element);
        opened = true;
      }
      fit();
      if (savedLine !== null) term.scrollToLine(savedLine);
      else term.scrollToBottom();
      savedLine = null;
      term.refresh(0, term.rows - 1);
    },
    detach() {
      if (opened) {
        const buffer = term.buffer.active;
        savedLine = buffer.viewportY >= buffer.baseY ? null : buffer.viewportY;
      }
      element.remove();
    },
    fit,
    focus: () => term.focus(),
    applyTheme() {
      term.options.theme = currentTheme();
      term.options.fontFamily = currentFontFamily();
    },
    dispose() {
      listeners.clear();
      connection.dispose();
      term.dispose();
      element.remove();
    },
  };
}

/** The tab's terminal, started the first time it is asked for. */
export function liveTerminal(terminalId: string, backend: TerminalsBackend): LiveTerminal {
  let entry = live.get(terminalId);
  if (entry === undefined) {
    entry = create(terminalId, backend);
    live.set(terminalId, entry);
  }
  return entry;
}

/** Lets go of the terminals of tabs that are no longer open. */
export function releaseClosedTerminals(openIds: ReadonlySet<string>): void {
  for (const [terminalId, entry] of live) {
    if (openIds.has(terminalId)) continue;
    live.delete(terminalId);
    entry.dispose();
  }
}

/**
 * Lets go of every terminal, for when this copy of the plugin's app goes (bb
 * reloaded or disabled the plugin): the shells keep running, and the next copy
 * reattaches to them.
 */
export function releaseAllTerminals(): void {
  releaseClosedTerminals(new Set());
}

/** Re-reads bb's theme into every terminal, after bb's light/dark mode or theme changes. */
export function applyThemeToAll(): void {
  for (const entry of live.values()) entry.applyTheme();
}
