/**
 * The host half of a relay to a Mac that is not the bb server's own: one TCP
 * connection to this Mac's Screen Sharing on 127.0.0.1:5900 per session,
 * driven by the server over bb's host link. Bytes are copied, never read.
 *
 * - Up: the server's `write` calls, numbered from 0. They are written to the
 *   socket in that order; one out of order ends the session, so a lost or
 *   reordered call can never scramble what reaches Screen Sharing.
 * - Down: what Screen Sharing sends goes out as `data` signals, numbered from
 *   0 and at most `maxChunkBytes` each; the server ends the session on a gap.
 *   When the session ends here, a `closed` signal follows the last `data`.
 * - Credit: the server returns `ack`s for what the viewer has received. While
 *   more than `windowBytes` is unacknowledged the socket is paused, so a slow
 *   viewer slows Screen Sharing down instead of growing a buffer here.
 * - Leases: each session holds a worker lease, so the daemon does not stop
 *   this worker under an open session, and releases it when it ends.
 * - Silence: a session the server has not called about for `silenceMs` ends.
 *   The server keeps an open session alive with `keepalive`; a server that
 *   went away without closing (a crash, a lost link) leaves nothing behind.
 */
import type { Socket } from "node:net";

export interface Lease {
  dispose(): Promise<void>;
}

/** How one session reaches the server; lent by the `open` call that started it. */
export interface SessionPort {
  emitData(payload: { sessionId: string; seq: number; data: string }): Promise<void>;
  emitClosed(payload: { sessionId: string; reason: string; failed: boolean }): Promise<void>;
  lease: Lease;
}

export interface HostRelayOptions {
  /** Opens the TCP connection to Screen Sharing. */
  connect(): Socket;
  /** Unacknowledged bytes allowed before the socket is paused. */
  windowBytes: number;
  maxChunkBytes: number;
  /** Bytes the server may send faster than Screen Sharing reads them before the session ends. */
  maxWriteBufferBytes: number;
  silenceMs: number;
  connectTimeoutMs: number;
  now(): number;
  log(message: string): void;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HostSession {
  private nextWriteSeq = 0;
  private nextDataSeq = 0;
  /** Bytes sent to the server as `data`, and acknowledged by it. */
  private emitted = 0;
  private acked = 0;
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private flushing = false;
  private paused = false;
  /** Set when the session is to end once what is pending has gone out. */
  private ending: { reason: string; failed: boolean } | null = null;
  ended = false;
  lastHeard: number;

  constructor(
    readonly id: string,
    private readonly socket: Socket,
    private readonly port: SessionPort,
    private readonly options: HostRelayOptions,
    private readonly forget: (session: HostSession) => void,
  ) {
    this.lastHeard = options.now();
    socket.on("data", (chunk: Buffer) => this.received(chunk));
    socket.on("error", (error) => this.endAfterPending(`cannot reach Screen Sharing (${errorCode(error)})`, true));
    socket.on("close", () => this.endAfterPending("Screen Sharing closed the connection", false));
  }

  heard(): void {
    this.lastHeard = this.options.now();
  }

  write(seq: number, data: string): void {
    this.heard();
    if (this.ended || this.ending !== null) return;
    if (seq !== this.nextWriteSeq) {
      this.end(`bytes from the viewer arrived out of order (expected ${this.nextWriteSeq}, got ${seq})`, true, true);
      return;
    }
    this.nextWriteSeq++;
    this.socket.write(Buffer.from(data, "base64"));
    if (this.socket.writableLength > this.options.maxWriteBufferBytes) {
      this.end("Screen Sharing is not reading", true, true);
    }
  }

  ack(bytes: number): void {
    this.heard();
    if (this.ended) return;
    if (bytes < this.acked || bytes > this.emitted) {
      this.end(`the viewer acknowledged ${bytes} bytes of ${this.emitted}`, true, true);
      return;
    }
    this.acked = bytes;
    this.applyWindow();
  }

  /** Ends the session now; `tell` sends the server a `closed` signal. */
  end(reason: string, failed: boolean, tell: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.socket.destroy();
    this.forget(this);
    void this.port.lease.dispose().catch(() => {});
    this.options.log(`session ${this.id} closed: ${reason}`);
    if (tell) {
      this.port.emitClosed({ sessionId: this.id, reason, failed }).catch((error: unknown) => {
        this.options.log(`could not say that session ${this.id} closed: ${errorText(error)}`);
      });
    }
  }

  private received(chunk: Buffer): void {
    if (this.ended) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.applyWindow();
    void this.flush();
  }

  /** Pauses the socket while too much is waiting for the viewer, and resumes it once enough is acknowledged. */
  private applyWindow(): void {
    const outstanding = this.pendingBytes + this.emitted - this.acked;
    if (!this.paused && outstanding > this.options.windowBytes) {
      this.paused = true;
      this.socket.pause();
    } else if (this.paused && outstanding <= this.options.windowBytes) {
      this.paused = false;
      this.socket.resume();
    }
  }

  /** Screen Sharing ended or failed: send what it said before it did, then say so. */
  private endAfterPending(reason: string, failed: boolean): void {
    if (this.ended || this.ending !== null) return;
    this.ending = { reason, failed };
    void this.flush();
  }

  /** Sends what is pending as `data` signals, one at a time and in order. */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.ended && this.pendingBytes > 0) {
        const chunk = this.take();
        const seq = this.nextDataSeq++;
        this.emitted += chunk.length;
        await this.port.emitData({ sessionId: this.id, seq, data: chunk.toString("base64") });
      }
    } catch (error) {
      this.end(`could not pass the screen on (${errorText(error)})`, true, false);
    } finally {
      this.flushing = false;
    }
    if (!this.ended && this.ending !== null && this.pendingBytes === 0) {
      this.end(this.ending.reason, this.ending.failed, true);
    }
  }

  /** Up to one chunk's worth of what is pending, as one buffer. */
  private take(): Buffer {
    const parts: Buffer[] = [];
    let size = 0;
    while (this.pending.length > 0 && size < this.options.maxChunkBytes) {
      const next = this.pending[0] as Buffer;
      const room = this.options.maxChunkBytes - size;
      if (next.length <= room) {
        parts.push(next);
        size += next.length;
        this.pending.shift();
      } else {
        parts.push(next.subarray(0, room));
        size += room;
        this.pending[0] = next.subarray(room);
      }
    }
    this.pendingBytes -= size;
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size);
  }
}

export class HostRelay {
  private readonly sessions = new Map<string, HostSession>();
  /** Sessions still connecting, so a second `open` for the same id is refused. */
  private readonly opening = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostRelayOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Connects a session. The port's lease is the caller's to take; from here
   * on the relay releases it, on failure as on every end.
   */
  async open(sessionId: string, port: SessionPort): Promise<void> {
    if (this.sessions.has(sessionId) || this.opening.has(sessionId)) {
      void port.lease.dispose().catch(() => {});
      throw new Error("session is already open");
    }
    this.opening.add(sessionId);
    const socket = this.options.connect();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), this.options.connectTimeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } catch (error) {
      socket.destroy();
      void port.lease.dispose().catch(() => {});
      throw new Error(`cannot reach Screen Sharing (${errorCode(error) === "error" ? errorText(error) : errorCode(error)})`);
    } finally {
      this.opening.delete(sessionId);
    }
    const session = new HostSession(sessionId, socket, port, this.options, (ended) => this.forget(ended));
    this.sessions.set(sessionId, session);
    this.options.log(`session ${sessionId} opened`);
    this.startSweep();
  }

  write(sessionId: string, seq: number, data: string): void {
    this.get(sessionId).write(seq, data);
  }

  ack(sessionId: string, bytes: number): void {
    this.get(sessionId).ack(bytes);
  }

  /** True while the session is open here. */
  keepalive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    session.heard();
    return true;
  }

  /** The server ended the session; it needs no `closed` signal. */
  close(sessionId: string): void {
    this.sessions.get(sessionId)?.end("closed by the server", false, false);
  }

  /** Ends every session, telling the server about each. */
  closeAll(reason: string): void {
    for (const session of [...this.sessions.values()]) session.end(reason, true, true);
  }

  /** Ends the sessions the server has gone quiet about. Runs on its own timer while any is open. */
  sweep(): void {
    const now = this.options.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastHeard >= this.options.silenceMs) session.end("the bb server stopped asking for it", true, true);
    }
  }

  private get(sessionId: string): HostSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("no such session");
    return session;
  }

  private forget(session: HostSession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    if (this.sessions.size === 0) this.stopSweep();
  }

  private startSweep(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sweep(), Math.max(1000, Math.floor(this.options.silenceMs / 4)));
    this.timer.unref?.();
  }

  private stopSweep(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
