/**
 * One tab's line to its shell: bb's terminal socket, `/ws/terminals/<id>` on
 * the page's own origin — the one bb's own terminal view and the Wterm
 * Terminal Preview plugin use (bb 0.48.1). The SDK lists, creates and closes
 * terminals but has no streaming call, and polling `terminals.output` would
 * put a round trip between every keystroke and its echo.
 *
 * The protocol, as bb 0.48.1's server speaks it:
 * - open with `?sinceSeq=<n>&outputAcks=1`; bb answers `attached`, replays
 *   the buffered output from `n` (at most the last 512 KB), then streams;
 * - every `output` chunk has a sequence number, so a reconnect resumes where
 *   it stopped and a duplicate is dropped;
 * - `ack` with the next sequence once the output is drawn is bb's flow
 *   control: bb paces the shell to its visible clients' acks, and stops
 *   waiting on a client that has not acked for 3 s. The tab's terminal keeps
 *   parsing, and acking, while the page is away;
 * - `ping` / `pong` keep the line honest, `exited` ends it, and an `error`
 *   with `terminal_not_found` means bb no longer has the session;
 * - attaching to a shell that has already exited gets `attached` with no
 *   replay and then `exited`: bb does not send the output it kept. That comes
 *   from `terminals.output` instead (`readRetained`), from the first sequence
 *   not yet drawn, before the tab says it ended;
 * - an attach can fail without the socket closing: bb sends an `error` such as
 *   `terminal_attach_timeout` (its own 10 s limit on the host's answer) and
 *   forgets the client, while the socket still answers pings. So any other
 *   error before `attached`, or no `attached` within `ATTACH_TIMEOUT_MS`,
 *   drops the socket and tries again.
 *
 * No React, no xterm: the socket and the clock are injected, so the
 * reconnect and replay rules are tested on their own (connection.test.ts).
 */

/** The parts of a browser WebSocket this file uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN = 1;

/**
 * - `connecting`: the first attach has not answered yet;
 * - `live`: attached to a running shell;
 * - `offline`: the socket is down and retrying, or the shell's machine is
 *   disconnected from bb (bb resumes the shell when it reconnects);
 * - `ended`: the shell exited, or bb no longer has the session.
 */
export type ConnectionState = "connecting" | "live" | "offline" | "ended";

export interface ConnectionStatus {
  state: ConnectionState;
  exitCode: number | null;
}

export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export interface ConnectionOptions {
  terminalId: string;
  /** Opens bb's terminal socket for this terminal, resuming at `sinceSeq`. */
  openSocket(terminalId: string, sinceSeq: number): SocketLike;
  /** Draws a chunk; calls `drawn` once it is on screen, which acknowledges it to bb. */
  write(bytes: Uint8Array, drawn: () => void): void;
  onStatus(status: ConnectionStatus): void;
  /**
   * The output bb kept for this terminal from `sinceSeq` on, read once it has
   * exited (`terminals.output`); null when bb no longer has it.
   */
  readRetained?(sinceSeq: number): Promise<readonly { seq: number; dataBase64: string }[] | null>;
  clock?: Clock;
}

/** How long to wait before each successive reconnect; the last repeats. */
export const RECONNECT_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000];
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
/** How long an open socket may go without `attached` before it is dropped and tried again. */
export const ATTACH_TIMEOUT_MS = 20_000;
/** Errors that mean the session is over, not that this attempt failed (bb 0.48.1). */
const ENDED_ERRORS = new Set(["terminal_not_found", "terminal_not_running", "terminal_exited", "terminal_closed"]);
/** bb takes at most 64 KiB per input message; stay well under it. */
export const INPUT_CHUNK_BYTES = 32 * 1024;
/** Typing queued while the socket is down, kept up to this much. */
export const INPUT_QUEUE_MAX_BYTES = 256 * 1024;

const defaultClock: Clock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

type SessionStatus = "starting" | "running" | "disconnected" | "exited";

export class TerminalConnection {
  private readonly options: ConnectionOptions;
  private readonly clock: Clock;
  private socket: SocketLike | null = null;
  private disposed = false;
  private finished = false;
  /** The sequence number of the next chunk not yet written. */
  private nextSeq = 0;
  private attempts = 0;
  private reconnectTimer: unknown = null;
  private heartbeat: unknown = null;
  private attachTimer: unknown = null;
  /** The socket bb has answered `attached` on; until then an error is this attempt's, not the session's. */
  private attachedSocket: SocketLike | null = null;
  private lastPongAt = 0;
  private status: ConnectionStatus = { state: "connecting", exitCode: null };
  private pendingInput: string[] = [];
  private pendingInputBytes = 0;
  private size: { cols: number; rows: number } | null = null;
  private sentSize: { cols: number; rows: number } | null = null;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.clock = options.clock ?? defaultClock;
  }

  get current(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    if (this.disposed || this.finished || this.socket !== null) return;
    const socket = this.options.openSocket(this.options.terminalId, this.nextSeq);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastPongAt = this.clock.now();
      this.startHeartbeat(socket);
      this.attachTimer = this.clock.setTimeout(() => {
        this.attachTimer = null;
        if (this.socket === socket && this.attachedSocket !== socket) this.retry(socket, "attach timeout");
      }, ATTACH_TIMEOUT_MS);
      this.sentSize = null;
      this.flushSize();
      this.flushInput();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handle(event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.dropSocket();
      if (this.disposed || this.finished) return;
      if (this.status.state !== "connecting") this.setStatus({ state: "offline", exitCode: null });
      this.scheduleReconnect();
    };
  }

  /** Sends what the user typed; queued (up to a bound) while the socket is down. */
  sendInput(data: string): void {
    for (const piece of splitUtf8(data, INPUT_CHUNK_BYTES)) this.sendPiece(piece);
  }

  /** Sends raw bytes (xterm's binary input: mouse reports outside UTF-8). */
  sendBytes(bytes: Uint8Array): void {
    for (let start = 0; start < bytes.length; start += INPUT_CHUNK_BYTES) {
      this.sendPiece(bytes.subarray(start, start + INPUT_CHUNK_BYTES));
    }
  }

  private sendPiece(piece: Uint8Array): void {
    if (this.disposed || this.finished || piece.byteLength === 0) return;
    const message = JSON.stringify({ type: "input", dataBase64: encodeBase64(piece) });
    if (this.socket?.readyState === OPEN) {
      this.socket.send(message);
    } else if (this.pendingInputBytes + piece.byteLength <= INPUT_QUEUE_MAX_BYTES) {
      this.pendingInput.push(message);
      this.pendingInputBytes += piece.byteLength;
    }
  }

  /** Asks bb to size the shell's terminal; the latest size is resent after a reconnect. */
  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    this.size = { cols, rows };
    this.flushSize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnect();
    const socket = this.socket;
    this.dropSocket();
    socket?.close(1000, "tab closed");
    this.pendingInput = [];
    this.pendingInputBytes = 0;
  }

  private handle(raw: unknown): void {
    const message = parseMessage(raw);
    if (message === null) return;
    switch (message.type) {
      case "attached":
        this.attempts = 0;
        this.attachedSocket = this.socket;
        this.clearAttachTimer();
        // A replay that starts later than asked lost the oldest output to bb's bound; carry on from there.
        if (message.replayStartSeq > this.nextSeq) this.nextSeq = message.replayStartSeq;
        this.applySession(message.session);
        return;
      case "output": {
        const { seq, dataBase64 } = message.chunk;
        if (seq < this.nextSeq) return;
        this.nextSeq = seq + 1;
        const acknowledged = this.nextSeq;
        const socket = this.socket;
        this.options.write(decodeBase64(dataBase64), () => {
          if (this.socket === socket && socket?.readyState === OPEN) {
            socket.send(JSON.stringify({ type: "ack", nextSeq: acknowledged }));
          }
        });
        return;
      }
      case "session-updated":
        this.applySession(message.session);
        return;
      case "exited":
        this.finish(message.session.exitCode, true);
        return;
      case "error":
        if (ENDED_ERRORS.has(message.code)) this.finish(null);
        // bb forgot this client when the attach failed; the socket would stay open and silent.
        else if (this.socket !== null && this.attachedSocket !== this.socket) this.retry(this.socket, message.code);
        return;
      case "pong":
        this.lastPongAt = this.clock.now();
        return;
    }
  }

  private applySession(session: { status: SessionStatus; exitCode: number | null }): void {
    if (session.status === "exited") return this.finish(session.exitCode, true);
    this.setStatus({ state: session.status === "disconnected" ? "offline" : "live", exitCode: null });
  }

  /** Stops for good; for a shell that exited, draws what bb kept of its output that this tab has not. */
  private finish(exitCode: number | null, exited = false): void {
    if (this.finished) return;
    this.finished = true;
    this.clearReconnect();
    const socket = this.socket;
    this.dropSocket();
    socket?.close(1000, "terminal ended");
    const ended = { state: "ended", exitCode } as const;
    if (!exited || this.options.readRetained === undefined) return this.setStatus(ended);
    this.options.readRetained(this.nextSeq).then(
      (chunks) => {
        if (this.disposed) return;
        for (const chunk of [...(chunks ?? [])].sort((a, b) => a.seq - b.seq)) {
          if (chunk.seq < this.nextSeq) continue;
          this.nextSeq = chunk.seq + 1;
          this.options.write(decodeBase64(chunk.dataBase64), () => undefined);
        }
        this.setStatus(ended);
      },
      (error: unknown) => {
        // bb keeps an exited shell's output for 30 minutes; after that the tab just shows what it had.
        console.warn(`terminals: could not read what ${this.options.terminalId} printed before it exited: ${String(error)}`);
        if (!this.disposed) this.setStatus(ended);
      },
    );
  }

  private setStatus(status: ConnectionStatus): void {
    if (status.state === this.status.state && status.exitCode === this.status.exitCode) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private flushSize(): void {
    const size = this.size;
    if (size === null || this.socket?.readyState !== OPEN) return;
    if (this.sentSize !== null && this.sentSize.cols === size.cols && this.sentSize.rows === size.rows) return;
    this.socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    this.sentSize = size;
  }

  private flushInput(): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) return;
    for (const message of this.pendingInput) socket.send(message);
    this.pendingInput = [];
    this.pendingInputBytes = 0;
  }

  /** Gives up on this socket and reconnects with the usual back-off. */
  private retry(socket: SocketLike, reason: string): void {
    this.dropSocket();
    socket.close(4001, reason.slice(0, 100));
    if (this.disposed || this.finished) return;
    this.setStatus({ state: "offline", exitCode: null });
    this.scheduleReconnect();
  }

  private clearAttachTimer(): void {
    if (this.attachTimer !== null) this.clock.clearTimeout(this.attachTimer);
    this.attachTimer = null;
  }

  private startHeartbeat(socket: SocketLike): void {
    this.stopHeartbeat();
    this.heartbeat = this.clock.setInterval(() => {
      if (this.socket !== socket || socket.readyState !== OPEN) return;
      if (this.clock.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        // onclose reconnects.
        socket.close(4000, "heartbeat timeout");
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.clock.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private dropSocket(): void {
    this.stopHeartbeat();
    this.clearAttachTimer();
    this.attachedSocket = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempts += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

/** bb's terminal socket URL on the page's own origin. */
export function terminalSocketUrl(location: { protocol: string; host: string }, terminalId: string, sinceSeq: number): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/terminals/${encodeURIComponent(terminalId)}?sinceSeq=${sinceSeq}&outputAcks=1`;
}

type ServerMessage =
  | { type: "attached"; replayStartSeq: number; nextSeq: number; session: { status: SessionStatus; exitCode: number | null } }
  | { type: "output"; chunk: { seq: number; dataBase64: string } }
  | { type: "session-updated"; session: { status: SessionStatus; exitCode: number | null } }
  | { type: "exited"; session: { status: SessionStatus; exitCode: number | null } }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

const SESSION_STATUSES = new Set<string>(["starting", "running", "disconnected", "exited"]);

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSession(value: unknown): { status: SessionStatus; exitCode: number | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || !SESSION_STATUSES.has(record.status)) return null;
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  return { status: record.status as SessionStatus, exitCode };
}

/** Parses one server message, or null for anything this file does not understand. */
export function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "attached": {
      const session = parseSession(record.session);
      if (session === null || !isSeq(record.replayStartSeq) || !isSeq(record.nextSeq)) return null;
      return { type: "attached", replayStartSeq: record.replayStartSeq, nextSeq: record.nextSeq, session };
    }
    case "output": {
      const chunk = record.chunk as Record<string, unknown> | null | undefined;
      if (typeof chunk !== "object" || chunk === null || !isSeq(chunk.seq) || typeof chunk.dataBase64 !== "string") return null;
      return { type: "output", chunk: { seq: chunk.seq, dataBase64: chunk.dataBase64 } };
    }
    case "session-updated":
    case "exited": {
      const session = parseSession(record.session);
      return session === null ? null : { type: record.type, session };
    }
    case "error":
      return typeof record.code === "string" ? { type: "error", code: record.code, message: String(record.message ?? "") } : null;
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

/** Splits text into UTF-8 pieces of at most `maxBytes`, never inside a character. */
export function splitUtf8(text: string, maxBytes: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const pieces: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    // Step back off continuation bytes (10xxxxxx) so a character stays whole.
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    // A character longer than maxBytes goes whole rather than never.
    if (end === start) {
      end = start + 1;
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
    }
    pieces.push(bytes.subarray(start, end));
    start = end;
  }
  return pieces;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const STEP = 8192;
  for (let index = 0; index < bytes.length; index += STEP) {
    binary += String.fromCharCode(...bytes.subarray(index, index + STEP));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
