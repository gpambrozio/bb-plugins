/**
 * Test support: bb's host link to other Macs, faked end to end. The plugin's
 * server runs on bb's fake plugin host; its host calls go through this fake
 * daemon to a real HostRelay per machine, and the relay's signals come back
 * through the fake host's signal delivery. Every call and every signal is
 * delayed by `oneWayMs` each way, in order, standing in for the ≈0.3 s
 * one-way trip to a laptop through getbb.app. Each Mac's Screen Sharing is a
 * fake one on a loopback port.
 */
import { connect } from "node:net";
import type { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { HostRelay, type HostRelayOptions } from "../host/relay";
import { MAX_CHUNK_BYTES } from "../shared/host-contract";
import { sleep } from "./fake-vnc";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];
type Call = { method: string; input: unknown; hostId: string };

export interface FakeDaemonOptions {
  /** Each machine's fake Screen Sharing port. */
  ports: Record<string, number>;
  oneWayMs: number;
  /**
   * Up to this much more on the way to the host, at random per call, so that
   * concurrent calls overtake each other — as bb's own server lets them, since
   * it awaits per call before sending each one.
   */
  callJitterMs?: number;
  windowBytes: number;
  silenceMs?: number;
  /** Answers `status` instead of probing. */
  status?: (hostId: string) => unknown;
}

export class FakeDaemon {
  readonly relays = new Map<string, HostRelay>();
  /** Every call that reached a machine, in order. */
  readonly calls: Call[] = [];
  leases = 0;
  harness: Harness | null = null;
  /** Machines whose link is down: calls fail and signals are lost. */
  readonly down = new Set<string>();

  constructor(private readonly options: FakeDaemonOptions) {}

  relayFor(hostId: string, overrides: Partial<HostRelayOptions> = {}): HostRelay {
    let relay = this.relays.get(hostId);
    if (relay === undefined) {
      const port = this.options.ports[hostId];
      if (port === undefined) throw new Error(`no fake Mac for ${hostId}`);
      relay = new HostRelay({
        connect: () => connect({ host: "127.0.0.1", port }),
        windowBytes: this.options.windowBytes,
        maxChunkBytes: MAX_CHUNK_BYTES,
        maxWriteBufferBytes: 8 * 1024 * 1024,
        silenceMs: this.options.silenceMs ?? 60_000,
        connectTimeoutMs: 2000,
        now: () => Date.now(),
        log: () => {},
        ...overrides,
      });
      this.relays.set(hostId, relay);
    }
    return relay;
  }

  /** What bb's fake plugin host calls for `bb.hosts.experimental_client(...).call`. */
  readonly call = async ({ method, input, hostId }: Call): Promise<unknown> => {
    await sleep(this.options.oneWayMs + Math.random() * (this.options.callJitterMs ?? 0));
    if (this.down.has(hostId)) throw new Error(`host ${hostId} is not connected`);
    this.calls.push({ method, input, hostId });
    try {
      return await this.handle(method, input as Record<string, never>, hostId);
    } finally {
      await sleep(this.options.oneWayMs);
    }
  };

  private async handle(method: string, input: Record<string, never>, hostId: string): Promise<unknown> {
    if (method === "status") return this.options.status?.(hostId);
    const relay = this.relayFor(hostId);
    switch (method) {
      case "open": {
        this.leases++;
        await relay.open(input.sessionId, {
          emitData: async (payload) => this.signal(hostId, "data", payload),
          emitClosed: async (payload) => this.signal(hostId, "closed", payload),
          lease: { dispose: async () => void this.leases-- },
        });
        return {};
      }
      case "write":
        relay.write(input.sessionId, input.seq, input.data);
        return {};
      case "ack":
        relay.ack(input.sessionId, input.bytes);
        return {};
      case "keepalive":
        return { open: relay.keepalive(input.sessionId) };
      case "close":
        relay.close(input.sessionId);
        return {};
      default:
        throw new Error(`unknown host method ${method}`);
    }
  }

  /** Delivered after the one-way delay, in the order sent; lost while the machine's link is down. */
  signal(hostId: string, name: string, payload: unknown): void {
    setTimeout(() => {
      if (this.down.has(hostId) || this.harness === null) return;
      // A signal that lands after the plugin stopped has nowhere to go, as in bb.
      this.harness.experimental_emitHostSignal(hostId, name, payload).catch(() => {});
    }, this.options.oneWayMs);
  }

  /** bb stopping the worker on a machine: its sessions end and tell the server. */
  stopWorker(hostId: string): void {
    this.relays.get(hostId)?.closeAll("the plugin's helper stopped");
  }

  openSessions(): number {
    return [...this.relays.values()].reduce((sum, relay) => sum + relay.size, 0);
  }

  closeEverything(): void {
    for (const relay of this.relays.values()) relay.closeAll("test over");
  }
}
