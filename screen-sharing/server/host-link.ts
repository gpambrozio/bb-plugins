/**
 * A session to a Mac that is not the bb server's own, over bb's host link to
 * that Mac's host entry (host.ts, host/relay.ts). The round trip to a laptop
 * through getbb.app is ≈0.6 s, so nothing here waits a round trip per key:
 *
 * - Up: the viewer's bytes are batched into `write` calls numbered from 0,
 *   with up to `maxPipelinedWrites` in flight at once. bb's host link may
 *   deliver them out of order; the host puts them back in order.
 * - Down: `data` signals numbered from 0; a gap (a signal lost or reordered on
 *   the way) ends the session, since a VNC stream with a hole in it is garbage.
 * - Credit: the viewer's acknowledgements go to the host as `ack`, one call in
 *   flight at a time, carrying the latest total. The host pauses reading from
 *   Screen Sharing while its window is unacknowledged, so what is in flight
 *   here is bounded by that window.
 * - Liveness: a quiet session calls `keepalive` every `keepaliveMs` — a few
 *   seconds, so a Mac that has gone ends its page's session in seconds; the
 *   host ends sessions the server stops asking about, and a call that fails
 *   or times out here ends the session, so neither end outlives the other.
 *
 * `HostLinks` keeps the open links by session id and routes the host's
 * signals to them, checking that a signal comes from the session's own host.
 */
import type { ExperimentalHostClient, StandardSchemaV1InferInput } from "@get-bb/plugin-sdk";

import { CloseCode } from "../shared/channels";
import { MAX_CHUNK_BYTES, type HostContract, type HostSignals } from "../shared/host-contract";
import { errorText, type Link, type LinkEvents } from "./link";

export type HostClient = Pick<ExperimentalHostClient<HostContract, HostSignals>, "call">;

export interface HostLinksOptions {
  client: HostClient;
  maxPipelinedWrites: number;
  /** Bytes the viewer may send faster than the host takes them before the session ends. */
  maxQueuedBytes: number;
  keepaliveMs: number;
  /** How long a keepalive may go unanswered before the session counts as lost. */
  keepaliveTimeoutMs: number;
  openTimeoutMs: number;
  now(): number;
  log(message: string): void;
}

export interface HostLinkTarget {
  hostId: string;
  hostName: string;
  sessionId: string;
}

class HostLink implements Link {
  private openSettled = false;
  private opened = false;
  private closed = false;
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  /** Writes sent and not yet answered, by number. */
  private readonly unanswered = new Set<number>();
  private inFlightBytes = 0;
  private nextWriteSeq = 0;
  private nextDataSeq = 0;
  private latestAck = 0;
  private forwardedAck = 0;
  private ackInFlight = false;
  private keepaliveInFlight = false;
  private lastHeard: number;

  constructor(
    readonly target: HostLinkTarget,
    private readonly options: HostLinksOptions,
    private readonly events: LinkEvents,
    private readonly forget: (link: HostLink) => void,
  ) {
    this.lastHeard = options.now();
  }

  start(): void {
    this.call("open", { sessionId: this.target.sessionId }, this.options.openTimeoutMs).then(
      () => {
        this.openSettled = true;
        this.opened = true;
        this.heard();
        // The relay gave up while the host was connecting: the host has a session nobody wants.
        if (this.closed) this.closeOnHost();
        else {
          this.pump();
          this.sendAck();
        }
      },
      (error: unknown) => {
        this.openSettled = true;
        // The call failed here (a timeout, a lost reply), yet the host may have connected.
        this.closeOnHost();
        this.fail(errorText(error));
      },
    );
  }

  write(bytes: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    if (this.queuedBytes + this.inFlightBytes > this.options.maxQueuedBytes) {
      this.fail("Screen Sharing is not reading");
      return;
    }
    this.pump();
  }

  ack(totalBytes: number): void {
    if (this.closed) return;
    this.latestAck = totalBytes;
    this.sendAck();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this);
    // Before `open` settles there is nothing to close yet; `start` closes it if it opens.
    if (this.openSettled && this.opened) this.closeOnHost();
  }

  receiveData(seq: number, data: string): void {
    if (this.closed) return;
    if (seq !== this.nextDataSeq) {
      this.fail(`lost part of the screen on the way (expected ${this.nextDataSeq}, got ${seq})`);
      return;
    }
    this.nextDataSeq++;
    this.heard();
    this.events.data(new Uint8Array(Buffer.from(data, "base64")));
  }

  /** The host ended the session itself, after its last `data`; it needs no `close`. */
  receiveClosed(reason: string, failed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this);
    this.events.end(failed ? CloseCode.failed : CloseCode.normal, this.onHost(reason));
  }

  /** bb's worker on the host exited; its sockets went with it. */
  workerExited(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this);
    this.events.end(CloseCode.failed, this.onHost("the plugin's helper stopped unexpectedly"));
  }

  keepalive(): void {
    if (!this.opened || this.closed || this.keepaliveInFlight) return;
    if (this.options.now() - this.lastHeard < this.options.keepaliveMs) return;
    this.keepaliveInFlight = true;
    this.call("keepalive", { sessionId: this.target.sessionId }, this.options.keepaliveTimeoutMs).then(
      ({ open }) => {
        this.keepaliveInFlight = false;
        this.heard();
        if (!open) this.fail("the Mac no longer has this session");
      },
      (error: unknown) => this.lost(error),
    );
  }

  /**
   * Sends what the viewer typed, a batch per call, without waiting on the
   * calls before it — but never more than `maxPipelinedWrites` numbers past
   * the earliest write still unanswered. Counting calls in flight is not
   * enough: the host answers a write that overtook an earlier one as soon as
   * it holds it, and later writes would then run far ahead of one delayed
   * call, past what the host holds (`MAX_WRITES_AHEAD` in host/relay.ts).
   */
  private pump(): void {
    while (this.opened && !this.closed && this.queuedBytes > 0 && this.nextWriteSeq - this.earliestUnanswered() < this.options.maxPipelinedWrites) {
      const chunk = this.take();
      const seq = this.nextWriteSeq++;
      this.unanswered.add(seq);
      this.inFlightBytes += chunk.length;
      this.call("write", { sessionId: this.target.sessionId, seq, data: chunk.toString("base64") }).then(
        () => {
          this.unanswered.delete(seq);
          this.inFlightBytes -= chunk.length;
          this.heard();
          this.pump();
        },
        (error: unknown) => this.lost(error),
      );
    }
  }

  private earliestUnanswered(): number {
    let earliest = this.nextWriteSeq;
    for (const seq of this.unanswered) earliest = Math.min(earliest, seq);
    return earliest;
  }

  /** The latest acknowledgement, one call at a time: a newer total replaces any not yet sent. */
  private sendAck(): void {
    if (!this.opened || this.closed || this.ackInFlight || this.latestAck <= this.forwardedAck) return;
    const bytes = this.latestAck;
    this.ackInFlight = true;
    this.call("ack", { sessionId: this.target.sessionId, bytes }).then(
      () => {
        this.ackInFlight = false;
        this.forwardedAck = bytes;
        this.heard();
        this.sendAck();
      },
      (error: unknown) => this.lost(error),
    );
  }

  private take(): Buffer {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (this.queue.length > 0 && size < MAX_CHUNK_BYTES) {
      const next = this.queue[0] as Uint8Array;
      const room = MAX_CHUNK_BYTES - size;
      if (next.length <= room) {
        parts.push(next);
        size += next.length;
        this.queue.shift();
      } else {
        parts.push(next.subarray(0, room));
        size += room;
        this.queue[0] = next.subarray(room);
      }
    }
    this.queuedBytes -= size;
    return Buffer.concat(parts, size);
  }

  private heard(): void {
    this.lastHeard = this.options.now();
  }

  private lost(error: unknown): void {
    this.fail(`lost the connection (${errorText(error)})`);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.events.end(CloseCode.failed, this.onHost(reason));
  }

  private onHost(reason: string): string {
    return `${this.target.hostName}: ${reason}`;
  }

  private closeOnHost(): void {
    this.call("close", { sessionId: this.target.sessionId }).catch((error: unknown) => {
      // The host also ends sessions the server goes quiet about, and all of them when its worker stops.
      this.options.log(`could not close session ${this.target.sessionId} on its Mac: ${errorText(error)}`);
    });
  }

  private call<M extends keyof HostContract & string>(
    method: M,
    input: StandardSchemaV1InferInput<HostContract[M]["input"]>,
    timeoutMs?: number,
  ) {
    try {
      return this.options.client.call(method, input, { hostId: this.target.hostId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    } catch (error) {
      // A client used after the plugin stopped throws at once; every caller handles a rejection.
      return Promise.reject(error);
    }
  }
}

export class HostLinks {
  private readonly links = new Map<string, HostLink>();

  constructor(private readonly options: HostLinksOptions) {}

  get size(): number {
    return this.links.size;
  }

  open(target: HostLinkTarget, events: LinkEvents): Link {
    const link = new HostLink(target, this.options, events, (ended) => {
      if (this.links.get(ended.target.sessionId) === ended) this.links.delete(ended.target.sessionId);
    });
    this.links.set(target.sessionId, link);
    link.start();
    return link;
  }

  data(hostId: string, payload: { sessionId: string; seq: number; data: string }): void {
    this.linkFor(hostId, payload.sessionId)?.receiveData(payload.seq, payload.data);
  }

  closed(hostId: string, payload: { sessionId: string; reason: string; failed: boolean }): void {
    this.linkFor(hostId, payload.sessionId)?.receiveClosed(payload.reason, payload.failed);
  }

  workerExited(hostId: string): void {
    for (const link of [...this.links.values()]) {
      if (link.target.hostId === hostId) link.workerExited();
    }
  }

  /** Keeps quiet sessions alive on their hosts. Run it on a timer. */
  keepalive(): void {
    for (const link of [...this.links.values()]) link.keepalive();
  }

  /** A signal counts only from the host its session was opened on. */
  private linkFor(hostId: string, sessionId: string): HostLink | undefined {
    const link = this.links.get(sessionId);
    if (link === undefined || link.target.hostId === hostId) return link;
    this.options.log(`ignored a signal for session ${sessionId} from another machine`);
    return undefined;
  }
}
